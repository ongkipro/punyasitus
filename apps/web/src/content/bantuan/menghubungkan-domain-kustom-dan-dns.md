---
slug: menghubungkan-domain-kustom-dan-dns
title: Cara Menghubungkan Domain Kustom (.id, .co.id, .com) & DNS
summary: Panduan lengkap menyambungkan domain sendiri ke PunyaSitus menggunakan Domain Wizard, record CNAME, verifikasi TXT, dan SSL otomatis.
category: domain
order: 1
updatedAt: 2026-11-23
readingMinutes: 5
keywords: [domain, dns, cname, txt, ssl, .id, .co.id, .com, cloudflare]
launchTopics: [domain]
relatedSlugs: [konfigurasi-cname-cloudflare-dan-ssl, migrasi-domain-tanpa-downtime, membayar-langganan-qris-dan-virtual-account]
featured: true
---

## Syarat sebelum menghubungkan domain

- Situs Anda harus berstatus **langganan berbayar aktif** (uji coba hanya menggunakan subdomain `.situsku.click`).
- Anda memiliki akses ke panel DNS registrar domain (seperti Niagahoster, Rumahweb, DomaiNesia, IDwebhost, GoDaddy, Namecheap, atau Cloudflare).
- Setiap situs mendukung hingga **2 hostname** (misalnya domain utama `namabisnis.co.id` dan `www.namabisnis.co.id`), dengan satu hostname ditetapkan sebagai domain primer.

## Memilih alur di Domain Wizard

Buka menu **Pengaturan > Domain**, masukkan nama domain Anda, lalu jawab pertanyaan **"Apakah situs di domain ini sudah live di tempat lain?"**:

1. **Domain baru (belum ada situs aktif)**: cukup tambahkan 1 record `CNAME` (atau CNAME flattening di root/apex) menuju target hostname yang tampil di dashboard.
2. **Pindahan tanpa downtime**: pasang record verifikasi kepemilikan (`TXT`) dan delegasi SSL lebih dahulu sementara situs lama tetap berjalan. Pindahkan record `CNAME` utama hanya setelah status sertifikat berubah menjadi **Aktif**.
3. **Domain dikelola di Cloudflare**: daftarkan domain di dashboard PunyaSitus terlebih dahulu, lalu arahkan `CNAME` terproksi di Cloudflare dengan mode enkripsi **Full** atau **Full (strict)**.

## Contoh susunan record DNS

| Tipe | Nama (Host) | Tujuan / Nilai | Keterangan |
| --- | --- | --- | --- |
| `CNAME` | `www` atau `@` | Target CNAME di dashboard | Mengarahkan trafik pengunjung ke PunyaSitus |
| `TXT` | `_cf-custom-hostname` | Token verifikasi unik | Boleh dihapus setelah status verifikasi aktif |
| `CNAME` | `_acme-challenge` | Target delegasi SSL | Biarkan tetap terpasang untuk perpanjangan SSL otomatis |

> Jangan mengubah record `MX`, `SPF`, `DKIM`, atau `DMARC` milik email bisnis Anda saat menambahkan record `CNAME` situs web.

## Memeriksa status propagasi & domain primer

Klik tombol **Periksa DNS** di halaman pengaturan domain. Propagasi DNS biasanya selesai dalam 5 hingga 30 menit (maksimal 24 jam tergantung TTL registrar). Setelah status domain dan sertifikat TLS keduanya **Aktif**, klik **Jadikan Domain Primer** agar subdomain `.situsku.click` otomatis mengalihkan pengunjung dengan `301` ke domain resmi Anda.
