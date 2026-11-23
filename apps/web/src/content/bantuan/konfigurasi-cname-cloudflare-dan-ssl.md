---
slug: konfigurasi-cname-cloudflare-dan-ssl
title: Pengaturan CNAME Cloudflare, Apex vs WWW & Mode SSL/TLS
summary: Langkah aman menyambungkan domain yang sudah memakai Cloudflare agar tidak terjadi redirect loop dan sertifikat SSL selalu aktif.
category: domain
order: 2
updatedAt: 2026-11-23
readingMinutes: 4
keywords: [cloudflare, cname, ssl, tls, full strict, redirect loop, orange cloud, apex]
launchTopics: [domain]
relatedSlugs: [menghubungkan-domain-kustom-dan-dns, migrasi-domain-tanpa-downtime]
featured: false
---

## Urutan wajib untuk domain di Cloudflare

Jika DNS domain Anda dikelola di akun Cloudflare sendiri, ikuti urutan ini agar validasi kepemilikan hostname berjalan lancar:

1. Daftarkan hostname Anda di **Pengaturan > Domain** pada dashboard PunyaSitus **terlebih dahulu** sebelum membuat record `CNAME` di Cloudflare.
2. Salin target `CNAME` dan record validasi yang muncul di dashboard PunyaSitus.
3. Buka menu **DNS > Records** di Cloudflare dan hapus record `A` atau `AAAA` lama pada hostname yang sama agar tidak bentrok.
4. Tambahkan record `CNAME` untuk `@` (root/apex — Cloudflare mendukung CNAME flattening otomatis) dan/atau `www` menuju target dari PunyaSitus.

## Pengaturan SSL/TLS agar terhindar dari redirect loop

Masalah paling umum pada pengguna Cloudflare adalah kesalahan `ERR_TOO_MANY_REDIRECTS`.

1. Di panel Cloudflare, buka menu **SSL/TLS > Overview**.
2. Pastikan mode enkripsi disetel ke **Full** atau **Full (strict)** — jangan gunakan mode **Flexible**.
3. Pastikan **Always Use HTTPS** aktif jika Anda ingin seluruh trafik `http://` beralih otomatis ke `https://`.

## Memilih domain primer: apex atau www

PunyaSitus mendukung domain apex (`bisnisanda.id`) maupun `www.bisnisanda.id` sebagai alamat utama.

- Jika memilih `bisnisanda.id` sebagai primer, pengunjung yang membuka `www.bisnisanda.id` akan diarahkan permanen (`301`) ke `bisnisanda.id`.
- Jika memilih `www.bisnisanda.id` sebagai primer, arahkan `bisnisanda.id` ke PunyaSitus juga agar pengalihan ke `www` bekerja seragam.

> Jika registrar lama Anda tidak mendukung `CNAME` di root (`@`), memindahkan pengelolaan DNS gratis ke Cloudflare adalah cara tercepat untuk mengaktifkan domain apex dengan SSL otomatis.
