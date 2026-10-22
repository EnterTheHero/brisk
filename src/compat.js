// Site compatibility fixes.
//
// Google refuses sign-in from browsers it thinks are built into an app ("This
// browser or app may not be secure") and can tell Brisk is built on Electron.
// It accepts Firefox. So requests to Google's sign-in page, and only those,
// carry current Firefox's user-agent header and none of Chromium's client-hint
// headers. Everywhere else Brisk looks like Chrome, and the signed-in cookies
// then work on Gmail, Drive, YouTube, etc. as usual. (Same approach as the Min
// and Firn browsers.)

const SIGNIN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);
if (process.env.BRISK_TEST_SIGNIN_HOST) SIGNIN_HOSTS.add(process.env.BRISK_TEST_SIGNIN_HOST); // tests only

// Firefox's version: Chromium's major version + 3 (they've stayed about that far apart since
// both moved to 4-week releases), so it updates with Electron and never claims a Firefox that
// isn't out yet. Capped by a date-based estimate as a second safety net. (Same approach as Firn;
// Min uses the date estimate.)
function firefoxVersion(now = Date.now()) {
  const fromChrome = Number(String(process.versions.chrome || '0').split('.')[0]) + 3;
  // Firefox 140 shipped 2025-06-24; releases every ~4 weeks with holiday gaps (4.1 weeks average), minus one to be safe.
  const fromDate = 140 + Math.floor((now - Date.UTC(2025, 5, 24)) / (4.1 * 7 * 24 * 3600 * 1000)) - 1;
  return fromChrome > 3 ? Math.min(fromChrome, fromDate) : fromDate;
}

function firefoxUA(platform = process.platform, now = Date.now()) {
  const v = firefoxVersion(now);
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}

function isSigninUrl(url) {
  try {
    return SIGNIN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Called from the session's onBeforeSendHeaders (only one listener is allowed per session).
function adjustRequestHeaders(details) {
  if (!isSigninUrl(details.url)) return;
  const h = details.requestHeaders;
  for (const name of Object.keys(h)) {
    if (name.toLowerCase().startsWith('sec-ch-ua') || name.toLowerCase() === 'user-agent') delete h[name];
  }
  h['User-Agent'] = firefoxUA();
}

// Earlier versions also changed what the sign-in page's scripts could see. Min and Firn,
// whose Google sign-in works, only change the network header, and the extra changes made
// Brisk's page look inconsistent, so that part is now off.
function registerCompatPreload() {}

module.exports = { adjustRequestHeaders, registerCompatPreload, firefoxUA, firefoxVersion, isSigninUrl, SIGNIN_HOSTS };
