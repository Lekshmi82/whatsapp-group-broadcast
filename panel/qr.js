'use strict';

// Turn a WhatsApp QR string into an SVG image for the browser.
// Uses the QR encoder that ships inside the qrcode-terminal package (already a dependency).
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

function qrSvg(text, { scale = 6, margin = 4 } = {}) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = (n + margin * 2) * scale;
    let path = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">`
        + `<rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { qrSvg };
