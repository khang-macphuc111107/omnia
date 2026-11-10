
async function run() {
  const r = await fetch('https://cursor.com/download', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }
  });
  const html = await r.text();
  const reg = /https:\/\/api2\.cursor\.sh\/updates\/download\/[^\\"s]+/g;
  const matches = Array.from(new Set(html.match(reg) || []));
  console.log('Matches:');
  matches.forEach(m => console.log(m));
}
run();

