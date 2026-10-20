@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 优先用 server.py（支持 Range 请求，听力音频可以拖动进度条）
where python >nul 2>nul
if %errorlevel%==0 (
    python server.py 8000
    goto :done
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py 8000
    goto :done
)

echo.
echo 没找到 Python。两种办法：
echo   1^) 装一个 Python 3（安装时勾选 Add Python to PATH），再双击本文件
echo   2^) 用 VS Code 装 Live Server 插件，右键 index.html - Open with Live Server
echo.
pause

:done
