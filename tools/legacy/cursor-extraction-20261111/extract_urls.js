
async function run() {
  const r = await fetch('https://cursor.com/download', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }
  });
  const html = await r.text();
  const idx = html.indexOf('"latestVersion"');
  if (idx !== -1) {
    console.log(html.slice(idx - 10, idx + 1500));
  } else {
    console.log('latestVersion not found');
  }
}
run();

