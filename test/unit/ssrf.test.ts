import { describe, expect, it } from 'vitest';
import { isPublicAddress, unmapIPv4 } from '../../src/lib/ssrf.js';
import { cleanText, parsePage, providerFor } from '../../src/lib/link-preview.js';

describe('isPublicAddress (SPEC §13 blocked ranges)', () => {
  const blocked: [string, string][] = [
    ['loopback', '127.0.0.1'],
    ['loopback, whole /8', '127.255.0.9'],
    ['RFC 1918 10/8', '10.1.2.3'],
    ['RFC 1918 172.16/12', '172.16.0.1'],
    ['RFC 1918 172.16/12 top', '172.31.255.254'],
    ['RFC 1918 192.168/16', '192.168.1.1'],
    ['link-local', '169.254.1.1'],
    ['cloud metadata', '169.254.169.254'],
    ['CGNAT 100.64/10', '100.64.0.1'],
    ['CGNAT 100.64/10 top', '100.127.255.254'],
    ['this network 0/8', '0.0.0.0'],
    ['this network 0/8', '0.1.2.3'],
    ['multicast', '224.0.0.1'],
    ['multicast top', '239.255.255.250'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['documentation', '192.0.2.10'],
    ['benchmarking', '198.18.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 ULA fc00::/7', 'fc00::1'],
    ['IPv6 ULA fd', 'fd12:3456:789a::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 link-local top', 'febf::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['NAT64 to loopback', '64:ff9b::7f00:1'],
    ['6to4', '2002:7f00:1::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback, hex', '::ffff:7f00:1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['IPv4-mapped RFC 1918', '::ffff:10.0.0.1'],
    ['IPv4-mapped CGNAT', '::ffff:100.64.0.1'],
    ['IPv4-mapped, long form', '0:0:0:0:0:ffff:192.168.0.1'],
    ['bracketed', '[::1]'],
    ['not an IP at all', 'localhost'],
    ['empty', ''],
  ];
  it.each(blocked)('blocks %s (%s)', (_what, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['93.184.216.34'], ['172.32.0.1'], ['100.128.0.1'], ['2606:4700::1111'], ['::ffff:8.8.8.8']])(
    'allows public %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it('unmaps IPv4-mapped IPv6 in both notations', () => {
    expect(unmapIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(unmapIPv4('::FFFF:a9fe:a9fe')).toBe('169.254.169.254');
    expect(unmapIPv4('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('parsePage', () => {
  const base = new URL('https://example.com/a/page');

  it('prefers og:, then twitter:, then <title>, decoding entities and stripping markup', () => {
    const page = parsePage(
      `<html><head><title>Fallback &amp; title</title>
       <meta property="og:title" content="Big &quot;launch&quot; &#x1F680;">
       <meta name="twitter:title" content="Twitter title">
       <meta name="description" content="  A <b>bold</b>\u202E plan&nbsp;here ">
       <meta property="og:site_name" content='Example'>
       <meta property="og:image" content="/img/card.png">
       <link rel="shortcut icon" href="favicon.png">
      </head></html>`,
      base,
    );
    expect(page).toEqual({
      title: 'Big "launch" 🚀',
      description: 'A bold plan here',
      siteName: 'Example',
      image: 'https://example.com/img/card.png',
      icon: 'https://example.com/a/favicon.png',
    });
    expect(parsePage('<title>Only <i>this</i></title>', base).title).toBe('Only this');
  });

  it('falls back to /favicon.ico, ignores non-http images and caps lengths', () => {
    const page = parsePage(
      `<meta property="og:image" content="javascript:alert(1)"><meta property="og:description" content="${'x'.repeat(2000)}">`,
      base,
    );
    expect(page.image).toBeNull();
    expect(page.icon).toBe('https://example.com/favicon.ico');
    expect([...page.description!].length).toBe(1000);
    expect(cleanText('y'.repeat(400), 300)!.length).toBe(300);
    expect(cleanText(' \u200B ', 300)).toBeNull();
  });
});

describe('providerFor', () => {
  it.each([
    ['https://docs.google.com/document/d/1', 'google_docs'],
    ['https://docs.google.com/spreadsheets/d/1', 'google_sheets'],
    ['https://docs.google.com/presentation/d/1', 'google_slides'],
    ['https://drive.google.com/file/d/1', 'google_drive'],
    ['https://www.dropbox.com/s/x', 'dropbox'],
    ['https://acme.sharepoint.com/sites/x', 'onedrive'],
    ['https://1drv.ms/x', 'onedrive'],
    ['https://app.box.com/s/x', 'box'],
    ['https://www.figma.com/file/x', 'figma'],
    ['https://youtu.be/x', 'youtube'],
    ['https://m.youtube.com/watch?v=x', 'youtube'],
    ['https://www.loom.com/share/x', 'loom'],
    ['https://github.com/a/b', 'github'],
    ['https://gitlab.com/a/b', 'gitlab'],
    ['https://www.notion.so/x', 'notion'],
    ['https://miro.com/app/board/x', 'miro'],
    ['https://acme.atlassian.net/browse/X-1', 'jira'],
    ['https://acme.atlassian.net/wiki/spaces/X', 'confluence'],
    ['https://acme.slack.com/archives/C1', 'slack'],
    ['https://us02web.zoom.us/j/1', 'zoom'],
    ['https://example.com/', null],
    ['https://notfigma.com/', null],
    ['https://figma.com.evil.example/', null],
  ])('%s → %s', (url, provider) => {
    expect(providerFor(new URL(url))).toBe(provider);
  });
});
