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
json.dump(out, sys.stdout, indent=1, sort_keys=True)
print()
