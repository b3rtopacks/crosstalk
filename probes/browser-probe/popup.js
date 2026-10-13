const $ = (id) => document.getElementById(id);
const ALLOWED = /^https:\/\/(claude\.ai|chatgpt\.com)\//;
let last = '';

$('dump').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !ALLOWED.test(tab.url || '')) {
    $('status').textContent = 'Active tab is not claude.ai or chatgpt.com.';
    return;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: dumpStructure,
      args: [{ textPreview: $('preview').checked }],
    });
    last = JSON.stringify(res.result, null, 2);
    $('out').value = last;
    $('status').textContent = `Dumped ${last.length} chars from ${new URL(tab.url).hostname}.`;
  } catch (e) {
    $('status').textContent = 'Failed: ' + e.message;
  }
};
$('copy').onclick = async () => { if (last) { await navigator.clipboard.writeText(last); $('status').textContent = 'Copied.'; } };
$('save').onclick = () => {
  if (!last) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([last], { type: 'application/json' }));
  a.download = `relay-probe-${Date.now()}.json`;
  a.click();
};
