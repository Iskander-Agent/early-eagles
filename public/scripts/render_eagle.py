#!/usr/bin/env python3
"""
Early Eagles — On-Chain Renderer
Fetches all segments from the Stacks blockchain and assembles a complete HTML eagle card.

Usage:
    python3 render_eagle.py <token_id>
    python3 render_eagle.py 0          # renders Frosty Narwhal

Output:  eagle_<token_id>.html  (open in any browser)

Zero dependencies — uses only Python stdlib.
Handles both plain string-ascii and response-ok wrapped Clarity values.

Source: https://early-eagles.vercel.app
"""
import sys, json, urllib.request

# ── Config ──────────────────────────────────────────────────────────
# These are the LIVE mainnet contracts.
# Both deployed from the same address on mainnet.
NETWORK       = "mainnet"
API           = "https://api.hiro.so"
NFT_ADDR      = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2"
NFT_NAME      = "early-eagles"
RENDERER_ADDR = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2"
RENDERER_NAME = "early-eagles-renderer"


# ── Clarity hex decoder ────────────────────────────────────────────
# The Hiro API returns Clarity values as hex strings.
# Two return types exist:
#   string-ascii         → 0x  0d  [4-byte len]  [ascii bytes]
#   (response ok string) → 0x  07  0d  [4-byte len]  [ascii bytes]
# The 07 is a response-ok wrapper. If not stripped, it corrupts output.
def clarity_decode_string(hex_str):
    h = hex_str[2:] if hex_str.startswith("0x") else hex_str
    # Unwrap response-ok (0x07) if present
    if h[:2] == "07":
        h = h[2:]
    # Check for error response
    if h[:2] == "08":
        raise ValueError(f"Contract returned error: 0x{h[:20]}...")
    # Expect string-ascii (0d) or string-utf8 (0e)
    type_byte = h[:2]
    if type_byte not in ("0d", "0e"):
        raise ValueError(f"Expected string type (0d/0e), got 0x{type_byte}")
    length = int(h[2:10], 16)
    raw = h[10:10 + length * 2]
    if len(raw) != length * 2:
        raise ValueError(f"Truncated: expected {length} bytes, got {len(raw)//2}")
    return bytes.fromhex(raw).decode("ascii")


# ── Hiro API caller ────────────────────────────────────────────────
def call_read(contract_addr, contract_name, function, args=None):
    url = f"{API}/v2/contracts/call-read/{contract_addr}/{contract_name}/{function}"
    body = json.dumps({
        "sender": contract_addr,
        "arguments": args or []
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    if not data.get("okay"):
        raise RuntimeError(f"API error on {function}: {data.get('cause', data)}")
    return data["result"]


def uint_cv(n):
    """Encode a uint as Clarity hex argument: 0x01 + 32 hex digits."""
    return "0x01" + format(int(n), "032x")


# ── Main ────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print("Usage: python3 render_eagle.py <token_id>")
        print("  e.g. python3 render_eagle.py 0")
        sys.exit(1)

    token_id = int(sys.argv[1])
    print(f"Rendering Early Eagle #{token_id}...")
    print(f"  NFT:      {NFT_ADDR}.{NFT_NAME}")
    print(f"  Renderer: {RENDERER_ADDR}.{RENDERER_NAME}")

    # Fetch the 4 renderer segments (same for every eagle)
    print("  Fetching seg1...", end=" ", flush=True)
    seg1 = clarity_decode_string(call_read(RENDERER_ADDR, RENDERER_NAME, "get-seg1"))
    print(f"{len(seg1)} bytes")

    print("  Fetching eagle...", end=" ", flush=True)
    eagle = clarity_decode_string(call_read(RENDERER_ADDR, RENDERER_NAME, "get-eagle"))
    print(f"{len(eagle)} bytes")

    print("  Fetching seg2...", end=" ", flush=True)
    seg2 = clarity_decode_string(call_read(RENDERER_ADDR, RENDERER_NAME, "get-seg2"))
    print(f"{len(seg2)} bytes")

    print("  Fetching seg3...", end=" ", flush=True)
    seg3 = clarity_decode_string(call_read(RENDERER_ADDR, RENDERER_NAME, "get-seg3"))
    print(f"{len(seg3)} bytes")

    # Fetch per-token render params (this one returns response-ok wrapped)
    print("  Fetching render params...", end=" ", flush=True)
    params = clarity_decode_string(
        call_read(NFT_ADDR, NFT_NAME, "get-render-params", [uint_cv(token_id)])
    )
    print(f"{len(params)} bytes")

    # Assemble: seg1 + eagle + seg2 + renderParams + seg3
    html = seg1 + eagle + seg2 + params + seg3

    outfile = f"eagle_{token_id}.html"
    with open(outfile, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n  Saved: {outfile} ({len(html):,} bytes)")
    print(f"  Open in any browser to view your eagle.")


if __name__ == "__main__":
    main()
