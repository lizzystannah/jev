@echo off
REM Mantém o backend da Bilheteria sempre ativo (reinicia se cair).
REM Uso: npm run start:always:bat   (ou duplo-clique neste ficheiro)
cd /d "%~dp0.."

:loop
echo [start-always] A iniciar servidor...
call npm start
echo [start-always] Servidor terminou. A reiniciar em 5s...
timeout /t 5 /nobreak >nul
goto loop
