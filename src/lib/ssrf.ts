import { BlockList, isIP } from 'node:net';

/**
 * Addresses the link-preview fetcher must never connect to (SPEC §13): the server's own network,
 * cloud metadata (169.254.169.254), and anything that isn't a public unicast address.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
// IPv6: only global unicast (2000::/3) at all, which rules out loopback, ULA, link-local, multicast,
// NAT64 (64:ff9b::/96, 64:ff9b:1::/48), IPv4-compatible (::a.b.c.d) and SIIT (::ffff:0:a.b.c.d) in one go.
// IPv4-mapped (::ffff:a.b.c.d) is unmapped and checked as IPv4 first.
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
for (const [net, prefix] of [
  ['2001::', 23], // IETF protocol assignments, incl. Teredo (2001::/32), which embeds an IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['3fff::', 20], // documentation (RFC 9637)
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** `::ffff:a.b.c.d` / `::ffff:7f00:1` → the IPv4 address it maps to; anything else unchanged. */
export function unmapIPv4(address: string): string {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return address;
}

/** True for an address the fetcher may connect to: a public unicast IPv4/IPv6 address. Not a hostname. */
export function isPublicAddress(address: string): boolean {
  const ip = unmapIPv4(address.replace(/^\[|\]$/g, ''));
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) return globalUnicast.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
  return false;
}
