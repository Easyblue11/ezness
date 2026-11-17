/**
 * 打开本机文件/文件夹的唯一出口。
 *
 * 现在底层是 Electron 的 shell；以后换平台（或改成“交给外部程序/远程端打开”）
 * 只替换这里，主进程里的调用方不用跟着改。文件和文件夹同时支持：
 *   - 文件：用系统默认程序打开；
 *   - 文件夹：用系统的文件管理器打开。
 */

function createFileOpener(shell) {
  return {
    /** 返回空字符串表示成功，否则是系统给出的错误说明。 */
    async openPath(target) {
      return shell.openPath(target);
    },

    /** 在文件管理器里定位并选中这个文件。 */
    revealPath(target) {
      shell.showItemInFolder(target);
    },
  };
}

module.exports = { createFileOpener };
