---
slug: memulihkan-situs-terkunci-atau-ditangguhkan
title: Memulihkan Situs Masa Tenggang, Terkunci, atau Ditangguhkan
summary: Pahami perbedaan status Masa Tenggang (H+1..H+3), Terkunci (H+4..H+7), dan Ditangguhkan (H+8..H+44), hak ekspor CSV, serta cara mengaktifkan situs seketika.
category: keamanan-pemulihan
order: 1
updatedAt: 2026-11-23
readingMinutes: 4
keywords: [terkunci, locked, ditangguhkan, suspended, masa tenggang, grace, pemulihan, perpanjangan]
launchTopics: [payment]
relatedSlugs: [membayar-langganan-qris-dan-virtual-account, mengelola-pesan-masuk-dan-ekspor-csv, mengunduh-kuitansi-pembayaran-pdf]
featured: true
---

## Jadwal status langganan saat melewati jatuh tempo

PunyaSitus melindungi peringkat SEO dan data prospek Anda dengan memberikan jeda bertahap sebelum situs publik dinonaktifkan sementara:

| Status & Jendela | Situs Publik | Akses Dashboard | Tindakan Utama |
| --- | --- | --- | --- |
| **Masa Tenggang (`H+1..H+3`)** | Tetap tayang & terindeks | Bisa menyunting penuh + spanduk pengingat kuning | Bayar perpanjangan sebelum `H+4` |
| **Terkunci (`H+4..H+7`)** | **Tetap tayang & terindeks** | Mode **hanya-baca** (lihat konten, ekspor CSV, bayar) | Bayar perpanjangan sebelum `H+8` |
| **Ditangguhkan (`H+8..H+44`)** | Halaman sementara (*"Situs dalam perbaikan"*, `503`) | Layar Pemulihan: bayar, kuitansi, dan **ekspor CSV** | Bayar perpanjangan agar langsung aktif |
| **Penghapusan Permanen (`H+45`)** | Tidak tersedia (`404`) | Pemberitahuan arsip dihapus (peringatan dikirim di H+38, H+42, H+44) | Buat situs baru |

## Cara mengaktifkan situs kembali dengan cepat

1. Masuk ke dashboard menggunakan akun **Pemilik situs** (atau hubungi agensi pengelola jika situs Anda dikelola oleh agensi).
2. Klik tombol **Bayar Perpanjangan Sekarang** pada spanduk peringatan atau layar pemulihan.
3. Selesaikan pembayaran paket Bulanan atau Tahunan melalui **QRIS** atau **Bank Virtual Account**.
4. Begitu pembayaran terkonfirmasi otomatis, status situs langsung kembali **Aktif** dan situs publik dapat diakses kembali dalam hitungan detik (kecuali jika sedang berada dalam penahanan kepatuhan operator).

## Jika situs ditangguhkan karena penahanan operator

Jika layar pemulihan menampilkan keterangan **Penahanan Operator (Operator Hold)**, situs sedang ditinjau terkait kepatuhan kebijakan penggunaan wajar. Ikuti petunjuk pada email pemberitahuan resmi yang dikirim ke pemilik situs untuk menyelesaikan klarifikasi bersama tim operasional.
