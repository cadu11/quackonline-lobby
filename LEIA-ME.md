# Servidor de salas do QuackOnline

Organiza apelidos, sessões, chat, "pronto" e repassa o código do host do DuckStation Netplay.
O jogo em si vai direto de um PC para o outro (não passa por aqui).

Não tem dependências: só `server.js` e `package.json`. Precisa de Node.js 18 ou mais novo.

## Testar no seu PC
    node server.js
Abra http://localhost:8080 no navegador: deve aparecer `{"name":"QuackOnline lobby","ok":true,...}`.
No QuackOnline, o endereço do servidor fica `ws://localhost:8080/ws`.

## Colocar na nuvem gratuita (Render)
1. Crie uma conta no GitHub e um repositório (pode ser privado) com estes 3 arquivos.
2. Crie uma conta em render.com e clique em **New → Web Service**, ligando o repositório.
3. Preencha: Runtime **Node**, Build Command `npm install`, Start Command `node server.js`, plano **Free**.
4. Quando terminar, o Render mostra um endereço como `https://quackonline-xxxx.onrender.com`.
5. No QuackOnline, o endereço do servidor fica `wss://quackonline-xxxx.onrender.com/ws`.

No plano gratuito o servidor "dorme" depois de 15 minutos sem ninguém conectado. A primeira pessoa
que abrir o QuackOnline depois disso espera cerca de 1 minuto até ele acordar (o QuackOnline avisa e
tenta de novo sozinho). Enquanto houver alguém conectado ele fica acordado.
