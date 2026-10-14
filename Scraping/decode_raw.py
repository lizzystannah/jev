import sys

def read_varint(b, i):
    shift = 0
    val = 0
    while True:
        x = b[i]; i += 1
        val |= (x & 0x7F) << shift
        if not (x & 0x80):
            return val, i
        shift += 7

def decode(b, depth=0, max_depth=6, out=None):
    if out is None:
        out = []
    i = 0
    n = len(b)
    fields = []
    while i < n:
        try:
            key, i = read_varint(b, i)
        except IndexError:
            break
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = read_varint(b, i)
            fields.append((fn, 'varint', v))
        elif wt == 1:
            fields.append((fn, 'fix64', b[i:i+8])); i += 8
        elif wt == 2:
            ln, i = read_varint(b, i)
            data = b[i:i+ln]; i += ln
            # try string
            try:
                s = data.decode('utf-8')
                is_str = all(31 < ord(c) or c in '\n\t' for c in s) and len(s) > 0
            except UnicodeDecodeError:
                is_str = False
            if is_str and len(data) < 300:
                fields.append((fn, 'str', s))
            else:
                # try submessage
                sub = None
                if depth < max_depth:
                    try:
                        sub = decode(data, depth+1, max_depth)
                    except Exception:
                        sub = None
                if sub:
                    fields.append((fn, 'msg', sub))
                else:
                    fields.append((fn, 'bytes', data[:60]))
        elif wt == 5:
            fields.append((fn, 'fix32', b[i:i+4])); i += 4
        else:
            break
    return fields

def show(fields, indent=0):
    from collections import Counter
    # group repeated field numbers
    counts = Counter(f[0] for f in fields)
    for fn, kind, v in fields:
        pad = '  ' * indent
        rep = f' x{counts[fn]}' if counts[fn] > 3 else ''
        if kind == 'msg':
            print(f'{pad}field {fn}{rep}: {{')
            show(v, indent+1)
            print(f'{pad}}}')
        elif kind == 'str':
            s = v if len(v) < 80 else v[:80] + '...'
            print(f'{pad}field {fn}{rep}: "{s}"')
        elif kind == 'varint':
            print(f'{pad}field {fn}{rep}: {v}')
        else:
            print(f'{pad}field {fn}{rep}: [{kind}] {v!r}')

if __name__ == '__main__':
    data = open(sys.argv[1], 'rb').read()
    f = decode(data, max_depth=8)
    show(f)
