
async function run() {
  const url = 'https://downloads.cursor.com/production/25b52e7d03ebf2d5608914158e119f7992432a34/win32/x64/system-setup/CursorSetup-x64-3.28.7.exe';
  const r = await fetch(url, { method: 'HEAD' });
  console.log('Status:', r.status);
  console.log('Size:', (parseInt(r.headers.get('content-length') || '0') / 1024 / 1024).toFixed(2), 'MB');
}
run();

