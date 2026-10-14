import json
from pathlib import Path
from decode_raw import decode, show

# Schema ao lado deste ficheiro (não depende do CWD — funciona dentro de
# contentores onde o bridge corre com cwd fora do workspace).
schema = json.load(open(Path(__file__).resolve().parent / 'protobuf_schema.json', encoding='utf-8'))
v1 = schema['app']['nested']['v1']['nested']

def fields_of(name):
    # support "Table.Row" or bare "Row" nested under known parents
    if '.' in name:
        parent, child = name.split('.', 1)
        node = v1.get(parent, {}).get('nested', {}).get(child, {})
        out = {}
        for fname, fdef in node.get('fields', {}).items():
            out[fdef['id']] = (fname, fdef['type'], fdef.get('rule', 'optional'))
        return out
    node = v1.get(name, {})
    out = {}
    for fname, fdef in node.get('fields', {}).items():
        out[fdef['id']] = (fname, fdef['type'], fdef.get('rule', 'optional'))
    if out:
        return out
    # search nested types with this name
    for pname, pnode in v1.items():
        child = pnode.get('nested', {}).get(name)
        if child and 'fields' in child:
            for fname, fdef in child['fields'].items():
                out[fdef['id']] = (fname, fdef['type'], fdef.get('rule', 'optional'))
            return out
    return out


def resolve_type(typ, parent=None):
    """Resolve protobuf type name, preferring nested under parent."""
    if parent and '.' in parent:
        root = parent.split('.')[0]
        if typ in v1.get(root, {}).get('nested', {}):
            return f'{root}.{typ}'
    if typ in v1:
        return typ
    for pname, pnode in v1.items():
        if typ in pnode.get('nested', {}):
            return f'{pname}.{typ}'
    return typ

def is_scalar(t):
    return t in ('int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
                 'bool', 'string', 'bytes', 'float', 'double', 'fixed32', 'fixed64')

def decode_msg(b, msg_name, depth=0):
    """Decode bytes as named message using schema."""
    if depth > 15:
        return {'_raw': b[:50]}
    fields = fields_of(msg_name)
    if not fields:
        # fallback generic
        raw = decode(b, max_depth=8)
        return {'_generic': raw}
    out = []
    i = 0
    n = len(b)
    while i < n:
        # read key
        shift = 0
        val = 0
        try:
            while True:
                x = b[i]; i += 1
                val |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            break
        fn, wt = val >> 3, val & 7
        if wt == 0:  # varint
            shift = 0
            v = 0
            try:
                while True:
                    x = b[i]; i += 1
                    v |= (x & 0x7F) << shift
                    if not (x & 0x80):
                        break
                    shift += 7
            except IndexError:
                break
            name, typ, rule = fields.get(fn, (f'f{fn}', 'unknown', 'optional'))
            if typ == 'bool':
                v = bool(v)
            out.append((fn, name, typ, v))
        elif wt == 1:  # 64-bit
            data = b[i:i+8]; i += 8
            name, typ, rule = fields.get(fn, (f'f{fn}', 'unknown', 'optional'))
            out.append((fn, name, typ, data))
        elif wt == 2:  # length-delimited
            shift = 0
            ln = 0
            try:
                while True:
                    x = b[i]; i += 1
                    ln |= (x & 0x7F) << shift
                    if not (x & 0x80):
                        break
                    shift += 7
            except IndexError:
                break
            data = b[i:i+ln]; i += ln
            name, typ, rule = fields.get(fn, (f'f{fn}', 'unknown', 'optional'))
            if typ == 'string':
                try:
                    out.append((fn, name, typ, data.decode('utf-8')))
                    continue
                except UnicodeDecodeError:
                    pass
            if typ == 'bytes':
                out.append((fn, name, typ, data))
                continue
            if typ == 'unknown':
                # try string
                try:
                    s = data.decode('utf-8')
                    if s and all(31 < ord(c) or c in '\n\t' for c in s) and len(s) < 400:
                        out.append((fn, name, 'string?', s))
                        continue
                except Exception:
                    pass
                # try as message
                try:
                    sub = decode_msg(data, typ, depth + 1)
                    if sub and not (isinstance(sub, dict) and '_raw' in sub and len(sub) == 1):
                        out.append((fn, name, 'msg?', sub))
                        continue
                except Exception:
                    pass
                out.append((fn, name, 'bytes', data[:40]))
                continue
            # known message type
            resolved = resolve_type(typ, msg_name)
            if resolved in v1 or '.' in resolved:
                try:
                    sub = decode_msg(data, resolved, depth + 1)
                    out.append((fn, name, resolved, sub))
                except Exception as e:
                    out.append((fn, name, resolved + '_err', str(e)))
            else:
                out.append((fn, name, typ, data[:40]))
        elif wt == 5:
            data = b[i:i+4]; i += 4
            name, typ, rule = fields.get(fn, (f'f{fn}', 'unknown', 'optional'))
            out.append((fn, name, typ, data))
        else:
            break
    return out

def get(msg, *names):
    """Get first value by field name from decoded list."""
    if not isinstance(msg, list):
        return None
    for item in msg:
        if len(item) >= 4 and item[1] in names:
            return item[3]
    return None

def get_all(msg, name):
    if not isinstance(msg, list):
        return []
    return [item[3] for item in msg if len(item) >= 4 and item[1] == name]

def pretty(msg, indent=0, max_items=50):
    if not isinstance(msg, list):
        print('  ' * indent + repr(msg)[:200])
        return
    for item in msg[:max_items]:
        if len(item) == 4:
            fn, name, typ, val = item
            if isinstance(val, list):
                print('  ' * indent + f'{name} ({typ}):')
                pretty(val, indent + 1, max_items)
            elif isinstance(val, bytes):
                print('  ' * indent + f'{name}: bytes[{len(val)}]')
            else:
                print('  ' * indent + f'{name}: {val!r}'[:200])

def decode_response(body: bytes, msg_name: str):
    """Decode full aiscore Response envelope into named message."""
    resp = decode_msg(body, 'Response')
    data = get(resp, 'data')
    if isinstance(data, bytes):
        return decode_msg(data, msg_name)
    if isinstance(data, list):
        return data
    return None


if __name__ == '__main__':
    b = open('football_comp_eliteserien.bin', 'rb').read()
    comp = decode_response(b, 'WebDbComp')
    print('== WebDbComp ==')
    pretty(comp, 0, 40)
    tables = get(comp, 'tables')
    print('\n== tables ==')
    pretty(tables, 0, 30)
