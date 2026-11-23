---
slug: migrasi-domain-tanpa-downtime
title: Memindahkan Domain dari Hosting Lama Tanpa Downtime
summary: Cara menerbitkan sertifikat SSL PunyaSitus lebih dulu sebelum memindahkan DNS sehingga situs lama tetap bisa diakses selama masa transisi.
category: domain
order: 3
updatedAt: 2026-11-23
readingMinutes: 4
keywords: [migrasi, pindahan, zero downtime, rollback, dns, hosting lama, ssl]
launchTopics: [domain]
relatedSlugs: [menghubungkan-domain-kustom-dan-dns, konfigurasi-cname-cloudflare-dan-ssl]
featured: false
---

## Prinsip migrasi tanpa downtime

Saat domain sudah digunakan oleh situs aktif di hosting lain, jangan langsung menghapus record `A` lama. Dengan alur **Pindahan tanpa downtime**, PunyaSitus menerbitkan sertifikat TLS dan memverifikasi kepemilikan lebih dulu sebelum trafik dipindahkan.

## Langkah 1 — Pasang record pra-verifikasi

1. Buka **Pengaturan > Domain** dan pilih alur **Pindahan tanpa downtime**.
2. Catat nilai record `A` atau `CNAME` lama di registrar Anda sebagai cadangan rollback.
3. Tambahkan **record TXT kepemilikan** dan **record CNAME delegasi SSL (`_acme-challenge`)** ke panel DNS Anda tanpa menyentuh record `A` situs lama.
4. Klik **Periksa Status** di dashboard. Selama langkah ini, pengunjung masih melihat situs lama Anda tanpa gangguan.

## Langkah 2 — Tunggu sertifikat dan hostname aktif

Dashboard akan menampilkan dua indikator: **Verifikasi Hostname** dan **Sertifikat SSL**. Langkah pemindahan `CNAME` utama sengaja terkunci sampai keduanya berstatus **Aktif**.

## Langkah 3 — Arahkan trafik ke PunyaSitus

1. Setelah kedua indikator aktif, turunkan TTL record lama (misalnya menjadi `300` detik) bila memungkinkan.
2. Ganti record `A` lama pada hostname terkait menjadi record `CNAME` yang ditampilkan pada Langkah 3 di dashboard.
3. Setelah situs baru terbuka di domain Anda, aktifkan opsi **Jadikan Domain Primer**.

## Catatan rollback jika perlu kembali ke situs lama

Jika Anda menemukan konten yang belum siap sesaat setelah pengalihan DNS, Anda cukup mengembalikan record `A`/`CNAME` di registrar ke nilai cadangan yang dicatat pada Langkah 1. Record TXT kepemilikan boleh dihapus setelah migrasi selesai, sedangkan record delegasi SSL sebaiknya dibiarkan tetap aktif selama domain terhubung ke PunyaSitus.
