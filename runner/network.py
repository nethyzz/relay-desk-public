"""Classify DNS addresses consistently for the adapter and local startup.

IPv4-mapped, IPv4-translated and well-known NAT64 /96 addresses must be
checked against their embedded IPv4 address, not only IPv6.is_global.
"""
import ipaddress

FAKE_NETWORK = ipaddress.ip_network('198.18.0.0/15')
TRANSLATION_PREFIXES = (
    ipaddress.ip_network('::ffff:0:0:0/96'),
    ipaddress.ip_network('64:ff9b::/96'),
)

def effective_address(value):
    address = ipaddress.ip_address(value)
    if address.version == 6:
        if address.ipv4_mapped is not None:
            return address.ipv4_mapped
        if any(address in prefix for prefix in TRANSLATION_PREFIXES):
            return ipaddress.IPv4Address(int(address) & 0xffffffff)
    return address

def public_address(value) -> bool:
    address = effective_address(value)
    return (address.is_global and not address.is_multicast and
            not address.is_reserved and not address.is_unspecified and
            not getattr(address, 'is_site_local', False))

def fake_address(value) -> bool:
    address = effective_address(value)
    return address.version == 4 and address in FAKE_NETWORK

def proxy_dns_addresses(addresses) -> bool:
    return bool(addresses) and any(fake_address(address) for address in addresses) and all(
        fake_address(address) or public_address(address) for address in addresses)
