export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const { videoUrl, format } = await request.json();

      if (!videoUrl || !format) {
        return new Response(JSON.stringify({ error: 'Missing videoUrl or format' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Extract video ID
      const videoIdMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
      if (!videoIdMatch) {
        return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const videoId = videoIdMatch[1];

      // Fetch video page
      const videoPageReq = await fetch(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&gl=US&hl=en&has_verified=1&bpctr=9999999999`
      );
      const videoPage = await videoPageReq.text();

      // Extract player config
      const playerConfigRegex = /;ytplayer\.config\s*=\s*({.+?});ytplayer|;ytplayer\.config\s*=\s*({.+?});/gm;
      const playerConfigMatch = playerConfigRegex.exec(videoPage);
      if (!playerConfigMatch) {
        throw new Error('Could not extract player config');
      }
      const playerConfig = JSON.parse(playerConfigMatch[1]);
      const playerResponse = JSON.parse(playerConfig.args.player_response);

      // Get JS player
      const jsPlayer = await getJsPlayer(videoPage);

      // Process all formats
      const formats = playerResponse.streamingData.formats || [];
      const adaptiveFormats = playerResponse.streamingData.adaptiveFormats || [];
      const allFormats = [...formats, ...adaptiveFormats].map(format => {
        let url = format.url;
        const cipher = format.signatureCipher || format.cipher;
        if (cipher) {
          const components = parseQueryString(cipher);
          const sig = applyActions(extractActions(jsPlayer), components.s);
          url = components.url + `&${encodeURIComponent(components.sp)}=${encodeURIComponent(sig)}`;
        }
        return { ...format, _url: url };
      });

      // Select format
      let selectedFormat;
      let ext;
      if (format === 'mp4') {
        selectedFormat = allFormats.find(f => f.itag === 22) || allFormats.find(f => f.itag === 18);
        ext = 'mp4';
      } else {
        selectedFormat = allFormats.find(f => f.itag === 140 && f.audioQuality) ||
                         allFormats.find(f => f.audioQuality && f.mimeType?.includes('audio/mp4'));
        ext = 'mp3';
      }

      if (!selectedFormat) {
        return new Response(JSON.stringify({ error: 'No suitable format available' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get title and sanitize
      const title = playerResponse.videoDetails.title.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${title}.${ext}`;

      return new Response(JSON.stringify({
        downloadUrl: selectedFormat._url,
        filename
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (ex) {
      console.error(ex);
      return new Response(JSON.stringify({ error: ex.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// Helper functions (from the Gist)
const parseQueryString = queryString =>
  Object.assign(
    {},
    ...queryString.split("&").map(kvp => {
      kva = kvp.split("=").map(decodeURIComponent);
      return { [kva[0]]: kva[1] };
    })
  );

const getJsPlayer = async videoPage => {
  let playerURL = JSON.parse(
    /"assets":.+?"js":\s*("[^"]+")/gm.exec(videoPage)[1]
  );
  if (playerURL.startsWith("//")) playerURL = "https:" + playerURL;
  else if (!playerURL.startsWith("http")) playerURL = "https://www.youtube.com" + playerURL;
  const jsPlayerFetch = await fetch(playerURL);
  return await jsPlayerFetch.text();
};

// Signature decoding functions (from ytdl-core)
const jsVarStr = "[a-zA-Z_\\$][a-zA-Z_0-9]*";
const jsSingleQuoteStr = `'[^'\\\\]*(:?\\\\[\\s\\S][^'\\\\]*)*'`;
const jsDoubleQuoteStr = `"[^"\\\\]*(:?\\\\[\\s\\S][^"\\\\]*)*"`;
const jsQuoteStr = `(?:${jsSingleQuoteStr}|${jsDoubleQuoteStr})`;
const jsKeyStr = `(?:${jsVarStr}|${jsQuoteStr})`;
const jsPropStr = `(?:\\.${jsVarStr}|\\[${jsQuoteStr}\\])`;
const jsEmptyStr = `(?:''|"")`;
const reverseStr = ":function\\(a\\)\\{(?:return )?a\\.reverse\\(\\)\\}";
const sliceStr = ":function\\(a,b\\)\\{return a\\.slice\\(b\\)\\}";
const spliceStr = ":function\\(a,b\\)\\{a\\.splice\\(0,b\\)\\}";
const swapStr = ":function\\(a,b\\)\\{var c=a\\[0\\];a\\[0\\]=a\\[b(?:%a\\.length)?\\];a\\[b(?:%a\\.length)?\\]=c(?:;return a)?\\}";
const actionsObjRegexp = new RegExp(
  `var (${jsVarStr})=\\{((?:(?:${jsKeyStr}${reverseStr}|${jsKeyStr}${sliceStr}|${jsKeyStr}${spliceStr}|${jsKeyStr}${swapStr}),?\\r?\\n?)+)\\};`
);
const actionsFuncRegexp = new RegExp(
  `${`function(?:${jsVarStr})?\\(a\\)\\{` +
  `a=a\\.split\\(${jsEmptyStr}\\);\\s*` +
  `((?:(?:a=)?${jsVarStr}${jsPropStr}\\(a,\\d+\\);)+)` +
  `return a\\.join\\(${jsEmptyStr}\\)` +
  `\\}`
);
const reverseRegexp = new RegExp(`(?:^|,)( ${jsKeyStr})${reverseStr}`, "m");
const sliceRegexp = new RegExp(`(?:^|,)( ${jsKeyStr})${sliceStr}`, "m");
const spliceRegexp = new RegExp(`(?:^|,)( ${jsKeyStr})${spliceStr}`, "m");
const swapRegexp = new RegExp(`(?:^|,)( ${jsKeyStr})${swapStr}`, "m");

const swapHeadAndPosition = (arr, position) => {
  const first = arr[0];
  arr[0] = arr[position % arr.length];
  arr[position % arr.length] = first;
  return arr;
};

const extractActions = body => {
  const objResult = actionsObjRegexp.exec(body);
  const funcResult = actionsFuncRegexp.exec(body);
  if (!objResult || !funcResult) return null;
  const obj = objResult[1].replace(/\$/g, "\\$");
  const objBody = objResult[2].replace(/\$/g, "\\$");
  const funcBody = funcResult[1].replace(/\$/g, "\\$");
  let result = reverseRegexp.exec(objBody);
  const reverseKey = result && result[1].replace(/\$/g, "\\$").replace(/\$|^'|^\|"|' $|" $/g, "");
  result = sliceRegexp.exec(objBody);
  const sliceKey = result && result[1].replace(/\$/g, "\\$").replace(/\$|^'|^\|"|' $|" $/g, "");
  result = spliceRegexp.exec(objBody);
  const spliceKey = result && result[1].replace(/\$/g, "\\$").replace(/\$|^'|^\|"|' $|" $/g, "");
  result = swapRegexp.exec(objBody);
  const swapKey = result && result[1].replace(/\$/g, "\\$").replace(/\$|^'|^\|"|' $|" $/g, "");
  const keys = `(${[reverseKey, sliceKey, spliceKey, swapKey].join("|")})`;
  const myreg = `(?:a=)?${obj}(?:\\.${keys}|\\['${keys}'\\]|\\["${keys}"\\])\\(a,(\\d+)\\)`;
  const tokenizeRegexp = new RegExp(myreg, "g");
  const tokens = [];
  while ((result = tokenizeRegexp.exec(funcBody)) !== null) {
    let key = result[1] || result[2] || result[3];
    switch (key) {
      case swapKey:
        tokens.push(`w${result[4]}`);
        break;
      case reverseKey:
        tokens.push("r");
        break;
      case sliceKey:
        tokens.push(`s${result[4]}`);
        break;
      case spliceKey:
        tokens.push(`p${result[4]}`);
        break;
    }
  }
  return tokens;
};

const applyActions = (tokens, _sig) => {
  let sig = _sig.split("");
  for (let i = 0, len = tokens.length; i < len; i++) {
    let token = tokens[i], pos;
    switch (token[0]) {
      case "r":
        sig = sig.reverse();
        break;
      case "w":
        pos = ~~token.slice(1);
        sig = swapHeadAndPosition(sig, pos);
        break;
      case "s":
        pos = ~~token.slice(1);
        sig = sig.slice(pos);
        break;
      case "p":
        pos = ~~token.slice(1);
        sig.splice(0, pos);
        break;
    }
  }
  return sig.join("");
};
