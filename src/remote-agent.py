# Remote workspace agent: runs on the ssh host (python3, stdlib only) for a workspace opened as
# `ssh:<host>`. The main process starts it once per host over ssh and talks JSON lines on
# stdin/stdout: {"id", "op", ...args} -> {"id", "ok": true, "result"} | {"id", "ok": false,
# "error": {"code", "message"}}. File contents travel base64-encoded. It runs as the ssh user, so it
# can do nothing a shell on that host couldn't; it only exists to make tree/editor/git round trips
# cheap (one connection, no process per call). Requests run on a small thread pool so a slow git
# status doesn't stall the tree.
import base64
import ctypes
import ctypes.util
import errno
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

VERSION = 1
_out_lock = threading.Lock()


def _send(msg):
    line = json.dumps(msg, separators=(',', ':')) + '\n'
    with _out_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


class AgentError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


def _abs(p):
    if not isinstance(p, str) or not p.startswith('/') or '\x00' in p:
        raise AgentError('EINVAL', 'absolute path required: %r' % (p,))
    return p


def _stat(p):
    try:
        st = os.stat(p)
    except OSError:
        return None
    import stat as S
    return {'isFile': S.S_ISREG(st.st_mode), 'isDir': S.S_ISDIR(st.st_mode),
            'size': st.st_size, 'mtimeMs': st.st_mtime_ns / 1e6}


def _entries(p):
    out = []
    with os.scandir(p) as it:
        for e in it:
            try:
                is_dir = e.is_dir()
                is_file = e.is_file()
            except OSError:
                is_dir = is_file = False
            out.append({'name': e.name, 'isDir': is_dir, 'isFile': is_file})
    return out


def op_hello(_a):
    return {'version': VERSION, 'home': os.path.expanduser('~'), 'python': sys.version.split()[0]}


def op_stat(a):
    return _stat(_abs(a['path']))


def op_readdir(a):
    p = _abs(a['path'])
    st = _stat(p)
    if not st:
        raise AgentError('ENOENT', 'Path not found: %s' % p)
    if not st['isDir']:
        raise AgentError('ENOTDIR', 'Not a directory: %s' % p)
    return _entries(p)


def op_readdirs(a):
    res = {}
    for p in a['paths']:
        try:
            res[p] = _entries(_abs(p))
        except (OSError, AgentError):
            res[p] = None
    return res


def op_read(a):
    p = _abs(a['path'])
    st = _stat(p)
    if not st or not st['isFile']:
        return None
    if st['size'] > int(a['max']):
        return {'tooLarge': True, 'size': st['size']}
    with open(p, 'rb') as f:
        data = f.read(int(a['max']) + 1)
    if len(data) > int(a['max']):
        return {'tooLarge': True, 'size': len(data)}
    return {'b64': base64.b64encode(data).decode('ascii')}


def op_write(a):
    # mode 'existing': overwrite a file that must already exist (editor save);
    # mode 'new': exclusive create (never follows or clobbers an existing name).
    p = _abs(a['path'])
    data = base64.b64decode(a['b64'])
    if a.get('mode') == 'new':
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, a.get('perm', 0o666))
    else:
        st = _stat(p)
        if not st or not st['isFile']:
            raise AgentError('ENOENT', 'File not found: %s' % p)
        fd = os.open(p, os.O_WRONLY | os.O_TRUNC)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    return _stat(p)


def op_mkdir(a):
    os.mkdir(_abs(a['path']), a.get('perm', 0o777))
    return True


# rename must never replace an existing name. renameat2(RENAME_NOREPLACE) makes that atomic even
# against other processes; where the kernel / filesystem lacks it, fall back to check-then-rename
# (safe against this agent's own requests, which mutate one at a time — see MUTATING_OPS).
try:
    _libc = ctypes.CDLL(ctypes.util.find_library('c') or 'libc.so.6', use_errno=True)
    _renameat2 = _libc.renameat2
    _renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
except (OSError, AttributeError):
    _renameat2 = None
_AT_FDCWD = -100
_RENAME_NOREPLACE = 1


def _rename_noreplace(src, dst):
    if _renameat2 is not None:
        if _renameat2(_AT_FDCWD, os.fsencode(src), _AT_FDCWD, os.fsencode(dst), _RENAME_NOREPLACE) == 0:
            return
        err = ctypes.get_errno()
        if err not in (errno.ENOSYS, errno.EINVAL):
            if err == errno.EEXIST:
                raise AgentError('EEXIST', 'Already exists: %s' % os.path.basename(dst))
            raise OSError(err, os.strerror(err), src)
    if os.path.lexists(dst):
        raise AgentError('EEXIST', 'Already exists: %s' % os.path.basename(dst))
    os.rename(src, dst)


def op_rename(a):
    _rename_noreplace(_abs(a['src']), _abs(a['dst']))
    return True


def op_delete(a):
    p = _abs(a['path'])
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p)
    else:
        os.remove(p)
    return True


def op_exists(a):
    return os.path.lexists(_abs(a['path']))


def op_realdir(a):
    # Resolve a user-typed directory (`~`, `~/x`, relative to home) to an absolute real path.
    p = a.get('path') or '~'
    if not isinstance(p, str) or '\x00' in p:
        raise AgentError('EINVAL', 'invalid path')
    p = os.path.expanduser(p)
    if not p.startswith('/'):
        p = os.path.join(os.path.expanduser('~'), p)
    p = os.path.realpath(p)
    if not os.path.isdir(p):
        raise AgentError('ENOTDIR', 'Not a directory: %s' % p)
    return p


def op_sh(a):
    # Fixed scripts from the main process (git status etc.), never user input.
    cwd = _abs(a['cwd'])
    try:
        r = subprocess.run(['bash', '-c', a['script']], cwd=cwd, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                           timeout=float(a.get('timeout', 10)))
    except subprocess.TimeoutExpired:
        raise AgentError('ETIMEDOUT', 'command timed out')
    return {'code': r.returncode, 'stdout': r.stdout.decode('utf-8', 'replace')}


def op_tempfile(a):
    # A 0600 file in a 0700 per-user directory, for handing pasted images to a CLI by path.
    d = os.path.join(os.path.expanduser('~'), '.cache', 'wsl-workbench', 'paste')
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    name = os.path.basename(a['name'])
    if not name or name in ('.', '..'):
        raise AgentError('EINVAL', 'invalid name')
    p = os.path.join(d, name)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(base64.b64decode(a['b64']))
    return p


# --- Workspace secrets: plaintext copies of a secret for a CLI on this host, mirroring the local
# copies in WSL (secrets.js MATERIALIZE_SCRIPT): <base>/wb-secrets/<slug>/<key>, 0600 in 0700
# directories, base = /run/user/<uid> (tmpfs) or /dev/shm/wslwb-<uid> when that is missing. Every
# directory must be ours and not a symlink, so a planted one is refused rather than written into.
_SECRET_SLUG_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')
_SECRET_KEY_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')


def _secret_names(a):
    slug, key = a.get('slug'), a.get('key')
    for v, rx in ((slug, _SECRET_SLUG_RE), (key, _SECRET_KEY_RE)):
        if not isinstance(v, str) or not rx.match(v) or v in ('.', '..'):
            raise AgentError('EINVAL', 'invalid secret name')
    return slug, key


def _secret_root():
    uid = os.getuid()
    base = os.environ.get('WB_SECRETS_BASE_TEST') or '/run/user/%d' % uid
    try:
        st = os.lstat(base)
        ok = stat.S_ISDIR(st.st_mode) and st.st_uid == uid
    except OSError:
        ok = False
    if not ok:
        base = '/dev/shm/wslwb-%d' % uid
    return base, os.path.join(base, 'wb-secrets')


def _secret_dir_ok(p, create=False):
    if create:
        try:
            os.mkdir(p, 0o700)
        except FileExistsError:
            pass
    st = os.lstat(p)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise AgentError('EPERM', 'refusing unsafe secrets directory: %s' % p)


def op_secret_put(a):
    slug, key = _secret_names(a)
    base, root = _secret_root()
    d = os.path.join(root, slug)
    for p in (base, root, d):
        _secret_dir_ok(p, create=True)
        os.chmod(p, 0o700)
    fd, tmp = tempfile.mkstemp(prefix='.tmp.', dir=d)  # 0600
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(base64.b64decode(a['b64']))
        target = os.path.join(d, key)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return target


def op_secret_remove(a):
    slug, key = _secret_names(a)
    base, root = _secret_root()
    d = os.path.join(root, slug)
    for p in (base, root, d):
        if not os.path.lexists(p):
            return True  # nothing was ever written there
        _secret_dir_ok(p)
    f = os.path.join(d, key)
    if os.path.lexists(f):
        os.remove(f)
    try:
        os.rmdir(d)  # only when it is now empty
    except OSError:
        pass
    return True


def op_secret_remove_all(_a):
    base, root = _secret_root()
    if not os.path.lexists(root):
        return True
    _secret_dir_ok(base)
    _secret_dir_ok(root)
    shutil.rmtree(root)
    return True


OPS = {k[3:]: v for k, v in globals().items() if k.startswith('op_')}
# Ops that change the filesystem run one at a time, in arrival order, on their own thread (like the
# local handlers' synchronous fs calls): no check-then-act interleaving between them, no two saves
# of one file mixing bytes, and a later save always lands last. They also exclude the readers below,
# so a read never sees a file between a save's truncate and its write. Reads and git run in
# parallel with each other (git only reads; it is not held back by an upload).
MUTATING_OPS = frozenset(['write', 'mkdir', 'rename', 'delete', 'tempfile',
                          'secret_put', 'secret_remove', 'secret_remove_all'])
READING_OPS = frozenset(['stat', 'readdir', 'readdirs', 'read', 'exists', 'realdir'])


class _RWLock(object):
    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False

    def acquire_read(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._readers += 1

    def release_read(self):
        with self._cond:
            self._readers -= 1
            if not self._readers:
                self._cond.notify_all()

    def acquire_write(self):
        with self._cond:
            while self._writer or self._readers:
                self._cond.wait()
            self._writer = True

    def release_write(self):
        with self._cond:
            self._writer = False
            self._cond.notify_all()


_fs_lock = _RWLock()


def _run(op, req):
    fn = OPS.get(op)
    if not fn:
        raise AgentError('ENOSYS', 'unknown op: %r' % (op,))
    if op in MUTATING_OPS:
        _fs_lock.acquire_write()
        try:
            return fn(req)
        finally:
            _fs_lock.release_write()
    if op in READING_OPS:
        _fs_lock.acquire_read()
        try:
            return fn(req)
        finally:
            _fs_lock.release_read()
    return fn(req)


def handle(req):
    rid = req.get('id')
    try:
        _send({'id': rid, 'ok': True, 'result': _run(req.get('op'), req)})
    except AgentError as e:
        _send({'id': rid, 'ok': False, 'error': {'code': e.code, 'message': str(e)}})
    except OSError as e:
        code = errno.errorcode.get(e.errno, 'EIO') if e.errno else 'EIO'
        _send({'id': rid, 'ok': False, 'error': {'code': code, 'message': '%s: %s' % (e.strerror or e, e.filename or '')}})
    except Exception as e:  # noqa: BLE001 - report, never die on one bad request
        _send({'id': rid, 'ok': False, 'error': {'code': 'EIO', 'message': repr(e)}})


def main():
    _send({'id': 0, 'ok': True, 'result': op_hello({})})
    pool = ThreadPoolExecutor(max_workers=4)
    serial = ThreadPoolExecutor(max_workers=1)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        (serial if req.get('op') in MUTATING_OPS else pool).submit(handle, req)
    serial.shutdown(wait=True)
    pool.shutdown(wait=True)


main()
