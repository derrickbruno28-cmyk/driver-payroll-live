const fs = require('node:fs');
let html = fs.readFileSync('Driver_Payroll.html','utf8');
html = html.replace('<script src="/socket.io/socket.io.js"></script>', '<script>window.PAYROLL_PREVIEW=true;</script>');
html = html.replace('<body>', '<body><div class="preview-banner">PREVIEW · Synthetic payroll · Changes stay in this browser · No production connection <button onclick="resetPreview()">Reset sample data</button></div>');
fs.mkdirSync('preview',{recursive:true});
fs.writeFileSync('preview/PBR_Payroll_Preview.html',html);
console.log('Built preview/PBR_Payroll_Preview.html');
