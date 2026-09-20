chrome.runtime.onInstalled.addListener(() => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker installed. Version: ${version}`);
});

chrome.runtime.onStartup.addListener(() => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker started. Version: ${version}`);
});
