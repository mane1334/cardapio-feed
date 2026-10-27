@echo off
REM Arranca o Cardapio em Feed no Windows e reinicia sozinho se o servidor parar.
REM Precisa do Node.js 18 ou mais recente (https://nodejs.org).
cd /d "%~dp0"
title Cardapio em Feed
:loop
echo.
echo === Cardapio em Feed a correr em http://localhost:3001 ===
echo (Painel: http://localhost:3001/painel   Fechar esta janela para parar)
node backend\server.js 3001
echo.
echo O servidor parou. A reiniciar em 3 segundos...
timeout /t 3 /nobreak >nul
goto loop
