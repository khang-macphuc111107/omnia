
async function run() {
  const url = 'https://api2.cursor.sh/updates/download/golden/win32-x64/cursor/3.28';
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  console.log('Status:', r.status);
  console.log('Location:', r.headers.get('location'));
}
run();

