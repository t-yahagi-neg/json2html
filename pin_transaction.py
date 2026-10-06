"""Disk-backed output history for one pin scope's publication attempts."""

from __future__ import annotations

import errno
import os
from pathlib import Path
import shutil
import stat
import tempfile


class ScopeHistory:
    """Capture before publishing, mark successful changes, then restore or close.

    A history belongs to one generation run. After restoration, only failed
    restores may be retried; do not publish further changes with that history.
    """

    def __init__(self) -> None:
        self._backups: dict[Path, Path | None] = {}
        self._changed: dict[Path, None] = {}
        self._failed_restore: set[Path] = set()

    def prepare(self, documents: dict[Path, str]) -> None:
        """Save each output's initial state once, without modifying the output."""
        for output in documents:
            if output in self._backups:
                continue
            try:
                mode = output.lstat().st_mode
            except FileNotFoundError:
                self._backups[output] = None
                continue
            if stat.S_ISDIR(mode):
                raise IsADirectoryError(
                    errno.EISDIR, "Output is a directory", str(output)
                )
            if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                raise OSError(errno.EINVAL, "Unsupported output file type", str(output))
            descriptor, name = tempfile.mkstemp(
                prefix=f".{output.name}.", suffix=".backup", dir=output.parent
            )
            backup = Path(name)
            try:
                os.close(descriptor)
                # copy2 creates a symlink itself when follow_symlinks is False.
                if stat.S_ISLNK(mode):
                    backup.unlink()
                shutil.copy2(output, backup, follow_symlinks=False)
            except BaseException:
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            self._backups[output] = backup

    def changed(self, documents: dict[Path, str]) -> None:
        """Record outputs only after their publication has succeeded."""
        for output in documents:
            if output not in self._backups:
                raise OSError(errno.EINVAL, "Output was not prepared", str(output))
        for output in documents:
            self._changed[output] = None

    def restore(self) -> list[str]:
        """Attempt every changed output; retain failed restores for retry."""
        errors: list[str] = []
        for output in reversed(list(self._changed)):
            backup = self._backups[output]
            try:
                if backup is None:
                    output.unlink(missing_ok=True)
                else:
                    os.replace(backup, output)
            except OSError as error:
                self._failed_restore.add(output)
                detail = f"{output}: {error}"
                if backup is not None:
                    detail += f" (backup retained: {backup})"
                errors.append(detail)
            else:
                self._failed_restore.discard(output)
                del self._changed[output]
        return errors

    def close(self) -> None:
        """Clean up best-effort, preserving recovery copies after restore failures."""
        for output, backup in list(self._backups.items()):
            if output in self._failed_restore:
                continue
            if backup is not None:
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    continue
            del self._backups[output]
            self._changed.pop(output, None)
