
const fs = require('fs');
const https = require('https');

const url = 'https://downloads.cursor.com/production/25b52e7d03ebf2d5608914158e119f7992432a34/win32/x64/system-setup/CursorSetup-x64-3.28.7.exe';
const dest = 'D:/Omnia/CursorSetup.exe';

console.log('Starting Cursor installer download...');
const file = fs.createWriteStream(dest);

function doDownload(curUrl) {
  https.get(curUrl, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log('Redirecting to', res.headers.location);
      doDownload(res.headers.location);
      return;
    }
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    res.on('data', chunk => {
      downloaded += chunk.length;
      if (downloaded % (20 * 1024 * 1024) < chunk.length) {
        console.log(`Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
      }
    });
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => console.log('Download complete:', dest));
    });
  }).on('error', err => {
    console.error('Download error:', err.message);
  });
}

doDownload(url);

