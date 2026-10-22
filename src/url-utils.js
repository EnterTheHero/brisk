// Decides whether address-bar text is a URL or a search. Pure, unit-tested.

const ALLOWED_SCHEMES = /^(https?|brisk|file|about|view-source):/i;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/;
const LOCAL = /^(localhost|[\w-]+\.(local|localhost|lan|home|internal))(:\d+)?(\/.*)?$/i;
// A dotted name ending in a 2+ letter TLD, optional port and path: example.com, sub.site.co.uk/page
const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i;

function resolveInput(input, searchUrl) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^javascript:/i.test(text) || /^data:/i.test(text)) return searchUrl(text);
  if (ALLOWED_SCHEMES.test(text)) return text;
  if (/\s/.test(text)) return searchUrl(text);
  if (LOCAL.test(text) || IPV4.test(text)) return `http://${text}`;
  if (DOMAIN.test(text)) return `https://${text}`;
  return searchUrl(text);
}

// What the address bar shows for a URL.
function displayUrl(url) {
  if (!url || url.startsWith('brisk://newtab')) return '';
  if (url.startsWith('brisk://error')) {
    try {
      return new URL(url).searchParams.get('url') || url;
    } catch {
      return url;
    }
  }
  return url;
}

module.exports = { resolveInput, displayUrl };
