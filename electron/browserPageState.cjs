const { isSafeHttpUrl } = require('./nativeBrowserUrls.cjs');

function chooseBrowserReload({ currentUrl, failedRestoreUrl, loadingUrl, targetUrl, homePage }) {
  const activeLoadingUrl =
    isSafeHttpUrl(loadingUrl) && browserPageUrlsMatch(loadingUrl, targetUrl) ? loadingUrl : null;
  if (
    activeLoadingUrl &&
    (!isSafeHttpUrl(currentUrl) || !browserPageUrlsMatch(activeLoadingUrl, currentUrl))
  ) {
    return { kind: 'load', url: activeLoadingUrl };
  }
  if (isSafeHttpUrl(currentUrl)) return { kind: 'reload', url: currentUrl };
  for (const url of [failedRestoreUrl, activeLoadingUrl, targetUrl, homePage]) {
    if (isSafeHttpUrl(url)) return { kind: 'load', url };
  }
  throw new Error('DROIDEX Browser has no valid page to reload.');
}

function browserPageUrlsMatch(left, right) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function chooseBrowserRestore({ currentUrl, targetUrl, homePage }) {
  if (isSafeHttpUrl(currentUrl)) return null;
  if (isSafeHttpUrl(targetUrl)) return targetUrl;
  if (isSafeHttpUrl(homePage)) return homePage;
  return null;
}

function browserTargetBeforeViewClose({ currentUrl, loadingUrl, targetUrl }) {
  for (const url of [loadingUrl, currentUrl, targetUrl]) {
    if (isSafeHttpUrl(url)) return url;
  }
  return null;
}

function userVisibleBrowserUrl(value) {
  if (value === 'about:blank') return value;
  if (!isSafeHttpUrl(value)) {
    throw new Error('DROIDEX Browser loaded an invalid page URL.');
  }
  return String(value);
}

function requireFreshBrowserSnapshot(result, requestId) {
  if (!result || typeof result !== 'object') {
    throw new Error('DROIDEX Browser did not return a result.');
  }
  if (result.requestId !== requestId) {
    throw new Error('DROIDEX Browser returned a mismatched snapshot result.');
  }
  if (!result.ok) {
    throw new Error(result.error || 'DROIDEX Browser snapshot failed.');
  }
  if (!result.snapshot) {
    throw new Error('DROIDEX Browser did not return a fresh page snapshot.');
  }
  if (!isSafeHttpUrl(result.snapshot.url)) {
    throw new Error('DROIDEX Browser returned an invalid page snapshot.');
  }
  return result;
}

function isExpectedSupersededLoad({ error, requestedUrl, targetUrl, currentUrl }) {
  const aborted =
    String(error?.code || '').includes('ERR_ABORTED') ||
    String(error?.message || '').includes('ERR_ABORTED');
  return (
    aborted &&
    isSafeHttpUrl(currentUrl) &&
    isSafeHttpUrl(targetUrl) &&
    !browserPageUrlsMatch(requestedUrl, targetUrl) &&
    browserPageUrlsMatch(currentUrl, targetUrl)
  );
}

module.exports = {
  browserTargetBeforeViewClose,
  chooseBrowserReload,
  chooseBrowserRestore,
  isExpectedSupersededLoad,
  requireFreshBrowserSnapshot,
  userVisibleBrowserUrl,
};
