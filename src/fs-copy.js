// Single-file copy that transfers ONLY the default data stream. fs.copyFileSync maps to Win32
// CopyFile, which also copies NTFS alternate data streams — e.g. Zone.Identifier, the Mark of the
// Web on browser-downloaded files — and WSL's 9P server materializes each extra stream as a literal
// `name:stream` junk file on ext4 (#47). A plain read/write loop copies just the real contents.
// Kept Electron-free so it can be unit-tested.

const fs = require('fs');

const COPY_BUFFER_SIZE = 4 * 1024 * 1024;

// Throws EEXIST when the destination already exists ('wx'), matching COPYFILE_EXCL semantics.
function copyFileContentsSync(source, destination) {
  const srcFd = fs.openSync(source, 'r');
  try {
    // Carry over the source's permission bits (fs.copyFileSync does the same); without an explicit
    // mode the destination would be created 0666 & ~umask and executables would lose their x bit.
    const mode = fs.fstatSync(srcFd).mode & 0o777;
    const dstFd = fs.openSync(destination, 'wx', mode);
    try {
      // openSync's mode is masked by the process umask; set the exact bits like fs.copyFileSync.
      fs.fchmodSync(dstFd, mode);
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
      let bytes;
      while ((bytes = fs.readSync(srcFd, buffer, 0, buffer.length)) > 0) {
        // writeSync may flush fewer bytes than asked; loop until the whole chunk is written.
        for (let written = 0; written < bytes; ) {
          written += fs.writeSync(dstFd, buffer, written, bytes - written);
        }
      }
      fs.closeSync(dstFd);
    } catch (error) {
      // Don't leave a partial destination behind: a retry would then fail with EEXIST, unlike
      // fs.copyFileSync, which removes the target after a failed copy.
      try { fs.closeSync(dstFd); } catch {}
      try { fs.unlinkSync(destination); } catch {}
      throw error;
    }
  } finally {
    // A failed close of the read-only source fd is inconsequential (all data was already read);
    // letting it throw here would mark an already-completed copy as failed and leave the
    // destination behind for a retry to trip over with EEXIST.
    try { fs.closeSync(srcFd); } catch {}
  }
}

module.exports = { copyFileContentsSync };
