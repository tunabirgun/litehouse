from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit


class DestinationPolicyError(ValueError):
    """Raised when a destination is outside the official-source boundary."""


@dataclass(frozen=True, slots=True)
class AllowedEndpoint:
    host: str
    path: str


@dataclass(frozen=True, slots=True)
class DestinationPolicy:
    endpoints: tuple[AllowedEndpoint, ...]

    def validate_url(self, url: str) -> SplitResult:
        if len(url) > 8192 or url != url.strip():
            raise DestinationPolicyError("Destination URL is not canonical.")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in url):
            raise DestinationPolicyError("Destination URL contains control characters.")
        if "#" in url:
            raise DestinationPolicyError("Destination URL fragments are forbidden.")

        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as error:
            raise DestinationPolicyError("Destination URL is malformed.") from error

        if parsed.scheme != "https":
            raise DestinationPolicyError("Destination must use HTTPS.")
        if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            raise DestinationPolicyError("Destination user information is forbidden.")
        if not parsed.hostname or "[" in parsed.netloc or "]" in parsed.netloc:
            raise DestinationPolicyError("Destination host is not allowed.")
        if port not in (None, 443):
            raise DestinationPolicyError("Destination port is not allowed.")

        raw_host = parsed.netloc.split(":", maxsplit=1)[0]
        if raw_host != parsed.hostname or parsed.hostname.endswith("."):
            raise DestinationPolicyError("Destination host is not canonical.")

        endpoint = AllowedEndpoint(host=parsed.hostname, path=parsed.path)
        if endpoint not in self.endpoints:
            raise DestinationPolicyError("Destination endpoint is not allowed.")
        return parsed

    @staticmethod
    def validate_addresses(addresses: tuple[str, ...]) -> tuple[str, ...]:
        if not addresses:
            raise DestinationPolicyError("Destination did not resolve to an address.")

        normalized: list[str] = []
        for address in addresses:
            normalized.append(DestinationPolicy.validate_address(address))
        return tuple(dict.fromkeys(normalized))

    @staticmethod
    def validate_address(address: str) -> str:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError as error:
            raise DestinationPolicyError("Destination resolved to an invalid address.") from error

        if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
            mapped = parsed.ipv4_mapped
            if not DestinationPolicy._is_public(mapped):
                raise DestinationPolicyError("Destination resolved to a non-public address.")
        if not DestinationPolicy._is_public(parsed):
            raise DestinationPolicyError("Destination resolved to a non-public address.")
        return str(parsed)

    @staticmethod
    def _is_public(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        return (
            address.is_global
            and not address.is_private
            and not address.is_loopback
            and not address.is_link_local
            and not address.is_multicast
            and not address.is_reserved
            and not address.is_unspecified
        )


OFFICIAL_SOURCE_POLICY = DestinationPolicy(
    endpoints=(
        AllowedEndpoint(host="api.openalex.org", path="/works"),
        AllowedEndpoint(host="api.crossref.org", path="/works"),
        AllowedEndpoint(
            host="www.ebi.ac.uk",
            path="/europepmc/webservices/rest/search",
        ),
        AllowedEndpoint(
            host="api.semanticscholar.org",
            path="/graph/v1/paper/search",
        ),
        AllowedEndpoint(host="www.loc.gov", path="/search/"),
        AllowedEndpoint(host="api.datacite.org", path="/dois"),
    )
)
