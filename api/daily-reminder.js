// Vercel Cron ile her gün 09:00'da (Türkiye saati) çalışır.
// Firestore'daki ürün ve faturalardan "yapılacaklar" listesini çıkarır,
// Firebase Authentication'daki tüm kayıtlı kullanıcılara mail gönderir.
//
// Test: GET /api/daily-reminder?dry=1            -> mail göndermez, HTML önizleme döner
//       GET /api/daily-reminder?to=biri@ornek.com -> sadece bu adrese gönderir
// (İkisi de "Authorization: Bearer <CRON_SECRET>" başlığı ister.)

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const TOP_FLOW = [
  'Yeni Ürün Bilgisi Geldi',
  'Fiyat İstendi',
  'S-Portal Talep Açıldı',
  "SAP'den Ürün Açıldı",
  'Pazarlamadan İçerik Talep Edildi',
  'Ürün Stok Talep Maili Atıldı',
];
const TSOFT = [
  'Ürün görselleri boyutlandırıldı',
  'Teknik özellik girildi',
  'Ürün açıklaması girildi',
  'Kullanım kılavuzu eklendi',
  'Sıkça sorulan sorular eklendi',
  'Ürün videoları eklendi',
  'Ürün AI Uzmanı eklendi',
  'Kategori seçildi',
  'Yayın durumu aktif edildi',
  'KDV dahil göster aktif edildi',
  'Liste aktif edildi',
];
const MARKETS = ['Trendyol', 'Hepsiburada', 'Amazon', 'N11', 'Beymen', 'İdefix', 'Pazarama'];

const UPCOMING_DAYS = 7; // bu kadar gün içindeki tarihler "yaklaşan" sayılır
const LATE_INVOICE_DAYS = 7; // muhasebeye bu günden uzun süredir teslim edilmeyen fatura "gecikmiş"

function initAdmin() {
  if (admin.apps.length) return;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayIstanbul() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' }); // YYYY-MM-DD
}
function dayDiff(fromYmd, toYmd) {
  return Math.round((new Date(toYmd + 'T00:00:00Z') - new Date(fromYmd + 'T00:00:00Z')) / 86400000);
}
function trDate(ymd) {
  const [y, m, d] = String(ymd).split('-');
  return d && m && y ? `${d}.${m}.${y}` : ymd;
}

function missing(map, list) {
  return list.filter((_, i) => !(map && map[i]));
}

function buildData(products, invoices) {
  const today = todayIstanbul();

  const productTasks = [];
  const upcoming = [];

  for (const p of products) {
    const mTop = missing(p.topFlow, TOP_FLOW);
    const mTsoft = missing(p.tsoft, TSOFT);
    const mMarket = missing(p.marketplaces, MARKETS);
    if (mTop.length + mTsoft.length + mMarket.length > 0) {
      productTasks.push({ p, mTop, mTsoft, mMarket });
    }

    const dates = [
      ['Gümrükten geçiş', p.logistics?.customsDate],
      ['Depoya giriş', p.logistics?.warehouseDate],
      ['Pazaryeri canlı', p.logistics?.launchDate],
    ];
    for (const [label, ymd] of dates) {
      if (!ymd) continue;
      const diff = dayDiff(today, ymd);
      if (diff >= 0 && diff <= UPCOMING_DAYS) upcoming.push({ p, label, ymd, diff });
    }
  }
  upcoming.sort((a, b) => a.diff - b.diff);

  const invoiceTasks = invoices
    .filter((inv) => !inv.accountingSubmitted || !inv.sos)
    .map((inv) => ({
      inv,
      age: inv.date ? dayDiff(inv.date, today) : 0,
      noAcc: !inv.accountingSubmitted,
      noSos: !inv.sos,
    }))
    .sort((a, b) => b.age - a.age);

  return { today, productTasks, upcoming, invoiceTasks };
}

function buildHtml({ today, productTasks, upcoming, invoiceTasks }, panelUrl) {
  const sec = (title, inner) =>
    `<h3 style="margin:24px 0 8px;font-size:15px;color:#0f172a;border-bottom:2px solid #16a34a;padding-bottom:4px">${title}</h3>${inner}`;

  let body = '';

  if (upcoming.length) {
    body += sec(
      `📅 Yaklaşan Tarihler (${UPCOMING_DAYS} gün)`,
      `<ul style="margin:0;padding-left:18px">${upcoming
        .map(
          (u) =>
            `<li style="margin-bottom:4px"><b>${esc(u.p.name)}</b> (${esc(u.p.sku)}) – ${u.label}: <b>${trDate(u.ymd)}</b> ${
              u.diff === 0 ? '<span style="color:#dc2626"><b>(BUGÜN)</b></span>' : u.diff === 1 ? '(yarın)' : `(${u.diff} gün sonra)`
            }</li>`
        )
        .join('')}</ul>`
    );
  }

  if (invoiceTasks.length) {
    body += sec(
      '🧾 Fatura Takibi',
      `<ul style="margin:0;padding-left:18px">${invoiceTasks
        .map((t) => {
          const parts = [];
          if (t.noAcc) parts.push(t.age > LATE_INVOICE_DAYS ? `<span style="color:#dc2626"><b>muhasebeye teslim edilmedi (${t.age} gün)</b></span>` : 'muhasebeye teslim edilmedi');
          if (t.noSos) parts.push('SOS talebi açılmadı');
          const amount = Number(t.inv.amount || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          return `<li style="margin-bottom:4px"><b>${esc(t.inv.title)}</b> – ₺${amount} – ${parts.join(', ')}</li>`;
        })
        .join('')}</ul>`
    );
  }

  if (productTasks.length) {
    body += sec(
      `📦 Tamamlanmamış Ürünler (${productTasks.length})`,
      productTasks
        .map(({ p, mTop, mTsoft, mMarket }) => {
          const line = (label, arr) =>
            arr.length ? `<div style="margin:2px 0"><span style="color:#64748b">${label}:</span> ${arr.map(esc).join(', ')}</div>` : '';
          return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <div style="font-weight:bold;color:#0f172a">${esc(p.name)} <span style="color:#64748b;font-weight:normal">(${esc(p.sku)})</span></div>
            <div style="font-size:13px;margin-top:4px">
              ${line('Genel adımlar', mTop)}
              ${line('T-Soft', mTsoft)}
              ${line('Açılmayan pazaryerleri', mMarket)}
            </div></div>`;
        })
        .join('')
    );
  }

  return `<!DOCTYPE html><html lang="tr"><body style="margin:0;background:#f1f5f9;padding:20px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1e293b">
    <h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">Günaydın, bugünün yapılacak işleri</h2>
    <div style="color:#64748b;font-size:12px">${trDate(today)} · E-Ticaret Operasyon ve Koordinasyon Paneli</div>
    ${body}
    <p style="margin-top:28px"><a href="${esc(panelUrl)}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold;display:inline-block">Panele Git</a></p>
  </div></body></html>`;
}

async function listAllEmails() {
  const emails = [];
  let token;
  do {
    const res = await admin.auth().listUsers(1000, token);
    res.users.forEach((u) => {
      if (u.email && !u.disabled) emails.push(u.email);
    });
    token = res.pageToken;
  } while (token);
  return emails;
}

module.exports = async (req, res) => {
  // Yetki kontrolü: Vercel Cron, CRON_SECRET tanımlıysa otomatik olarak Bearer başlığı gönderir.
  const secret = process.env.CRON_SECRET;
  const okHeader = req.headers.authorization === `Bearer ${secret}`;
  const okKey = req.query.key === secret; // tarayıcıdan test için: ?key=CRON_SECRET
  if (!secret || (!okHeader && !okKey)) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  try {
    initAdmin();
    const db = admin.firestore();
    const [pSnap, iSnap] = await Promise.all([db.collection('products').get(), db.collection('invoices').get()]);
    const products = pSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const invoices = iSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const data = buildData(products, invoices);
    const nothing = !data.productTasks.length && !data.upcoming.length && !data.invoiceTasks.length;
    const panelUrl = process.env.PANEL_URL || 'https://istakip-three.vercel.app';
    const html = buildHtml(data, panelUrl);

    if (req.query.dry) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }
    if (nothing) return res.status(200).json({ sent: 0, note: 'Yapılacak iş yok, mail gönderilmedi.' });

    const recipients = req.query.to ? [String(req.query.to)] : await listAllEmails();
    if (!recipients.length) return res.status(200).json({ sent: 0, note: 'Alıcı bulunamadı.' });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const subject = `Günlük Yapılacaklar · ${trDate(data.today)}`;
    let sent = 0;
    const failed = [];
    for (const to of recipients) {
      try {
        await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
        sent++;
      } catch (e) {
        console.error('Mail gönderilemedi:', to, e.message);
        failed.push(to);
      }
    }
    return res.status(200).json({ sent, failed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
