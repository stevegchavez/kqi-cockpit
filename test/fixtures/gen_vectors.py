#!/usr/bin/env python3
"""
Generates test/fixtures/niu_vectors.json from the reference Python implementation
(niu_proto.py from https://github.com/BaesTheorem/niu-kqi, MIT licensed) using
made-up TEST keys only. The JS port in js/protocol.js must reproduce these bytes.

Usage:  python3 test/fixtures/gen_vectors.py /path/to/niu-kqi-checkout > test/fixtures/niu_vectors.json
"""
import json, sys
sys.path.insert(0, sys.argv[1])
import niu_proto as P

PWD = "0123456789abcdef"          # fake blePassword
AES = "fedcba9876543210"          # fake bleAes
AES_HEX32 = "00112233445566778899aabbccddeeff"  # the 32-hex-char key form
RND = "a1" * 8 + "5c" * 8         # fixed "random" for the handshake

out = {"pwd": PWD, "aes": AES, "aesHex32": AES_HEX32, "rnd": RND}

# handshake
body = "012301" + P.aes_enc(RND, PWD)
out["hs1Frame"] = body + P.checksum(body)
reply = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
out["hs1Reply"] = reply
b = "01a301" + P.aes_enc(reply, PWD)          # what the scooter sends back
out["hs1ReplyFrame"] = b + P.checksum(b)
out["hs2Frame"] = P.hs2_v1(RND, reply, PWD)
ok = "0183" + "00" + P.aes_enc("00" + "11" * 15, PWD)
out["hs2OkFrame"] = ok + P.checksum(ok)
bad = "0183" + "00" + P.aes_enc("07" + "11" * 15, PWD)
out["hs2BadFrame"] = bad + P.checksum(bad)
rej = "01c300" + P.aes_enc("2a" + "00" * 15, PWD)
out["hs1RejectFrame"] = rej + P.checksum(rej)

# reads
groups = {
    "fast": ["foc_k_rt_speed", "bms_soc_rt", "db_k_realtime_status", "db_k_f_code", "bms_soh_rt"],
    "static": ["foc_k_max_speed", "bms_rated_vlt", "db_k_sw_ver", "bms_c_cont"],
    "long": ["db_k_sw_ver", "foc_k_s_ver", "bms_s_ver_n"],   # 24 bytes -> two reply frames
}
out["reads"] = {}
for gname, names in groups.items():
    out["reads"][gname] = {"names": names, "request": P.build_read(names, AES)}
    out["reads"][gname]["requestHex32Key"] = P.build_read(names, AES_HEX32)

def reply_frames(names, values_hex, key):
    return P.build_chunked("01a1", "0181", values_hex, key)

# fast reply: speed 123 (12.3 km/h), soc 59, realtime status 0x00420001 (bit 1 set), fcode 0, soh 93
fast_hex = "007b" + "3b" + "00420001" + "00" + "5d"
out["reads"]["fast"]["replyFrames"] = reply_frames(groups["fast"], fast_hex, AES)
out["reads"]["fast"]["expected"] = P.parse_read_frames(out["reads"]["fast"]["replyFrames"], groups["fast"], AES)
static_hex = "012c" + "30" + "4b32433246563332" + "0097"   # max 300, 48 V, "K2C2FV32", 151 cycles
out["reads"]["static"]["replyFrames"] = reply_frames(groups["static"], static_hex, AES)
out["reads"]["static"]["expected"] = P.parse_read_frames(out["reads"]["static"]["replyFrames"], groups["static"], AES)
long_hex = "4b32433246563332" + "4b44453133473037" + "4b33443636563032"
out["reads"]["long"]["replyFrames"] = reply_frames(groups["long"], long_hex, AES)
out["reads"]["long"]["expected"] = P.parse_read_frames(out["reads"]["long"]["replyFrames"], groups["long"], AES)

# error reply: scooter refuses (code 0x40), as seen live for foc_k_assist_max_speed
e = "01e1" + "00" + P.aes_enc("40" + "00" * 15, AES)
out["readErrorFrame"] = e + P.checksum(e)
# corrupt checksum
bad_cs = out["reads"]["fast"]["replyFrames"][0][:-2] + "00"
out["badChecksumFrame"] = bad_cs
# frame loss: 2-frame reply with the second frame removed
out["lossFrames"] = out["reads"]["long"]["replyFrames"][:1]
# value decoding
out["decode"] = {
    "U16": P.decode_value({"type": "U16", "len": 2}, "012c"),
    "UTF8": P.decode_value({"type": "UTF-8", "len": 8}, "4b32433246563332"),
    "UTF8_nulpad": P.decode_value({"type": "UTF-8", "len": 8}, "4b32430000000000"),
}

# ---- Diagnostics: every field type, against the full catalogue (js/fields.js is generated from the same table)
import struct
def enc(name, value):
    """Field value -> hex, via the reference implementation."""
    return P.encode_value(P.FIELDS[name], value)

def pick(typ, n=1):
    return [k for k, v in sorted(P.FIELDS.items()) if v["type"] == typ][:n]

diag_groups = {
    "ints":   ["bms_soc_rt", "foc_k_rt_speed", "db_k_realtime_status"],
    "signed": pick("S8", 1) + pick("S16", 1) + pick("S32", 1),
    "floats": pick("F32", 2),
    "hex":    ["ble_mac", "db_left_menu_set", "db_usrdef_voice1"],
    "bigHex": ["db_island_notification"],                 # 128 bytes -> an eight-frame reply
    "text":   ["db_k_sw_ver", "foc_k_s_ver", "bms_s_ver_n"],
}
sample = {
    "bms_soc_rt": 59, "foc_k_rt_speed": 123, "db_k_realtime_status": 4325377, "db_k_sw_ver": "K2C2FV32",
    "foc_k_s_ver": "KDE13G07", "bms_s_ver_n": "K3D66V02",
}
out["diag"] = {}
for gname, names in diag_groups.items():
    vals_hex = ""
    raws = {}
    for i, n in enumerate(names):
        spec = P.FIELDS[n]
        if n in sample:
            h = enc(n, sample[n])
        elif spec["type"] in ("S8", "S16", "S32"):
            h = enc(n, -(i + 2))                       # negative on purpose
        elif spec["type"] == "F32":
            h = struct.pack(">f", [1.5, -2.25, 100.125][i % 3]).hex()
        elif spec["type"] == "HEX":
            h = bytes((0xA0 + i + j) & 0xFF for j in range(spec["len"])).hex()
        else:
            h = enc(n, i + 1)
        raws[n] = h
        vals_hex += h
    frames = P.build_chunked("01a1", "0181", vals_hex, AES)
    out["diag"][gname] = {
        "names": names,
        "types": {n: P.FIELDS[n]["type"] for n in names},
        "request": P.build_read(names, AES),
        "replyFrames": frames,
        "expected": P.parse_read_frames(frames, names, AES),
        "raws": raws,
    }

# a push frame: coded pairs in one encrypted block
push_plain = "21000903" + "21000b00c8"
push_plain += "0" * (32 - len(push_plain))
pf = "0127" + "00" + P.aes_enc(push_plain, AES)
# The reference keeps trailing zero padding as a bogus code_000000 entry; the JS port stops at padding on purpose.
def _no_padding(d):
    return {k: v for k, v in d.items() if k != "code_000000"}
out["push"] = {"frame": pf + P.checksum(pf), "expected": _no_padding(P.parse_push(pf + P.checksum(pf), AES))}
unk_plain = "21000903" + "ABCDEF" + "0102"
unk_plain += "0" * (32 - len(unk_plain))
uf = "0127" + "00" + P.aes_enc(unk_plain, AES)
out["pushUnknown"] = {"frame": uf + P.checksum(uf), "expected": _no_padding(P.parse_push(uf + P.checksum(uf), AES))}

json.dump(out, sys.stdout, indent=1, sort_keys=True)
print()
