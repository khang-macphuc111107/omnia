
async function run() {
  const r = await fetch('https://cursor.com/download', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }
  });
  const html = await r.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (nextDataMatch) {
    console.log('Found __NEXT_DATA__!');
    const data = JSON.parse(nextDataMatch[1]);
    console.log(JSON.stringify(data).slice(0, 1000));
  } else {
    // Check all script tags
    const scripts = html.match(/<script[^>]*>([^<]+)<\/script>/g) || [];
    console.log('Script count:', scripts.length);
    for (const s of scripts) {
      if (s.includes('download') || s.includes('anysphere') || s.includes('.exe')) {
        console.log('Script snippet:', s.slice(0, 300));
      }
    }
  }
}
run();

