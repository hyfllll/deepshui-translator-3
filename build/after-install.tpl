#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# chrome-sandbox 必须为 root:root + 4755，否则 SUID sandbox 启动即崩溃。
# 注意：不能用 unshare 探测 userns —— postinst 以 root 运行，探测结果永远为"支持"，
# 但普通用户运行应用时 AppArmor 会拦截非特权 userns，仍需 SUID 助手。
# 且非 root 构建的 deb 中文件属主是构建用户，必须显式 chown。
# 因此统一无条件设置 root:root + 4755，兼容所有系统。
if [ -f '/opt/${sanitizedProductName}/chrome-sandbox' ]; then
    chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
