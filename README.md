# Whale Tracker (Hyperliquid)

Dashboard tracking whale open-position berdasarkan data **Hyperliquid public API** (bukan scraping hypurrscan — hypurrscan itu sendiri cuma UI di atas data Hyperliquid, dan tidak menyediakan endpoint scraping publik yang reliable).

## Cara jalan (VS Code)

1. Buka folder ini di VS Code.
2. Install extension **Live Server** (oleh Ritwick Dey), atau pakai extension apa saja yang bisa serve static file.
3. Klik kanan `index.html` → **Open with Live Server**.
4. Klik tombol **Refresh Data** di web.

Tidak perlu `npm install` apa pun — ini pure HTML/CSS/JS, tanpa build step.

## Update: batchClearinghouseStates tidak dipakai lagi

Versi awal script ini pakai endpoint `batchClearinghouseStates` — ternyata endpoint itu **tidak didukung oleh public Hyperliquid API** (selalu balas HTTP 500/null untuk semua address, dikonfirmasi lewat dokumentasi resmi Chainstack). Endpoint itu cuma tersedia di provider node berbayar pihak ketiga (GoldRush, Dwellir), bukan di `api.hyperliquid.xyz` gratis.

Sekarang app ini pakai `clearinghouseState` (single-user, endpoint resmi) dipanggil satu per satu dengan concurrency terbatas (6 request paralel) + retry otomatis kalau kena rate limit (429). Konsekuensinya: refresh butuh ~10-20 detik untuk 45 address, bukan instan.

## Fitur notifikasi perubahan posisi

Ada toggle **"Auto-refresh"** di pojok kanan atas. Kalau diaktifkan:
- App akan refresh data tiap 60 detik otomatis (ubah `AUTO_REFRESH_MS` di `app.js` kalau mau interval lain).
- Tiap refresh, posisi whale dibandingkan dengan hasil refresh sebelumnya.
- Kalau ada whale yang **buka posisi baru, tutup posisi, balik arah (long↔short), atau ubah ukuran >5%**, kamu akan dapat: bunyi beep, notifikasi browser (via Notification API), dan highlight oranye berkedip di baris tabel yang berubah.

**Batasan penting yang perlu kamu tahu — bukan bug, tapi keterbatasan arsitektur:**
- Ini **BUKAN** notifikasi seperti aplikasi HP yang tetap masuk walau app ditutup. Tab browser **harus tetap terbuka** (boleh di-minimize atau pindah tab lain, browser tetap harus jalan) — kalau tab/browser ditutup, timer auto-refresh berhenti dan tidak ada yang memantau.
- Snapshot pembanding disimpan di memori JavaScript, **hilang setiap kali kamu reload halaman**. Refresh pertama setelah reload tidak akan memicu notifikasi apa pun (karena belum ada data pembanding) — itu wajar.
- Kalau kamu butuh notifikasi yang tetap jalan walau laptop mati / browser ditutup, itu butuh arsitektur berbeda: server kecil yang jalan 24/7 (VPS atau selalu-nyala) yang polling API dan kirim ke Telegram Bot/Discord webhook. Kasih tahu saya kalau kamu mau ke arah itu — itu proyek terpisah, bukan modifikasi kecil dari app ini.
- Browser akan minta izin notifikasi saat pertama kali kamu klik "Refresh Data" atau aktifkan auto-refresh — klik "Allow", kalau "Block" makanya notifikasi browser tidak akan muncul (tapi beep dan highlight tabel tetap jalan).

## PENTING: soal CORS

CORS **kemungkinan besar bukan masalah** untuk endpoint `clearinghouseState` — endpoint ini dipakai luas oleh dashboard frontend pihak ketiga. Tapi kalau kamu tetap lihat error CORS / "Failed to fetch" di Console (F12), solusinya:

### Opsi A — Proxy lokal kecil (paling reliable)
Buat file `server.js`:
```js
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

app.post("/proxy/info", async (req, res) => {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  res.json(await r.json());
});

app.listen(3001, () => console.log("Proxy jalan di http://localhost:3001"));
```
Jalankan: `npm init -y && npm install express cors node-fetch && node server.js`
Lalu di `app.js`, ganti `HL_API` menjadi `"http://localhost:3001/proxy/info"`.

### Opsi B — Cek dulu sebelum panik
Buka `https://api.hyperliquid.xyz/info` langsung, atau test dengan curl:
```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"clearinghouseState","user":"0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36"}'
```
Kalau curl berhasil tapi browser gagal → itu murni CORS, pakai Opsi A.

## Catatan tentang data

- **Filter <$1M** hanya berlaku di tabel "Tracked whales" (per-posisi individual, bukan per-whale). Gauge, Net Bias, dan panel "Positioning per coin" dihitung dari **SEMUA** posisi whale (sesuai konfirmasi kamu).
- **1 address duplikat** ditemukan di daftar kamu (`0xccf3fff3...`, muncul 2x) — otomatis di-dedupe.
- **1 vault** (`hypurrscan.io/vault/0xb0a55f13...`) di-skip dari fetch karena vault butuh endpoint berbeda (`vaultDetails`), bukan `clearinghouseState`. Kalau kamu mau data vault-nya juga ditampilkan, bilang saja — saya bisa tambahkan endpoint terpisah untuk itu.
- Arah **long/short** ditentukan dari tanda `szi` (position size) di response API: positif = long, negatif = short. Ini beda dari asumsi naif "lihat warna" — saya pakai raw signed value langsung dari Hyperliquid.
- Data **real-time** dari Hyperliquid, jadi angka akan berbeda dari screenshot referensi kamu (itu snapshot lama).

## Struktur file
```
whale-tracker/
├── index.html      # struktur halaman
├── style.css       # dark theme
├── whales.js       # daftar 45 address whale (setelah dedup)
├── app.js          # fetch, agregasi, render
└── README.md
```
