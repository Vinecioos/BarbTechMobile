# BarbTech — Plataforma de agendamento para barbearias

O **BarbTech** é uma aplicação para aproximar clientes e profissionais de barbearia, facilitando a descoberta de profissionais, a consulta de serviços e preços e o agendamento de atendimentos na barbearia ou em domicílio. O projeto também inclui ferramentas para o profissional gerenciar sua agenda e acompanhar resultados.

Esta versão inclui uma interface web empacotada para Android com **Capacitor**, integração com **Firebase** e serviços opcionais para chatbot e segurança.

## Funcionalidades

### Para clientes
- Cadastro e login por e-mail e senha; login com Google sujeito à configuração.
- Perfil do cliente e validação de endereço por CEP.
- Busca de profissionais, com filtro por região e ordenação por proximidade quando há dados de localização disponíveis.
- Consulta de serviços, preços, horários e promoções.
- Agendamento e remarcação de atendimentos na barbearia ou em domicílio, conforme a disponibilidade do profissional.
- Consulta de agendamentos, notificações e preferências de privacidade.
- Chatbot com opções guiadas; respostas digitadas por IA dependem da configuração do serviço de chatbot.

### Para profissionais
- Cadastro e gerenciamento do perfil e da barbearia.
- Cadastro de serviços, preços, horários de trabalho e atendimento em domicílio.
- Gerenciamento de agendamentos.
- Publicação de novidades e promoções.
- Painel de resultados com indicadores de atendimentos e faturamento.

### Segurança e privacidade
- Regras de acesso do Firestore definidas no projeto.
- Controles de sessão, validação de entradas e opções de segurança no perfil.
- Funcionalidades adicionais de segurança, como recuperação por código, auditoria e limitação de tentativas, disponíveis conforme a configuração do serviço `backend-seguranca`.
- Documentação de segurança em `docs/BarbTech-Seguranca-v6.pdf`, se esse arquivo estiver presente na versão publicada.

> **Importante:** algumas integrações precisam de configuração externa e nem todas foram testadas em ambiente real. Consulte [Testes e limitações](#testes-e-limitações).

## Tecnologias

As tecnologias utilizadas podem variar conforme os módulos habilitados nesta versão. O projeto inclui:

- **Capacitor** para empacotar a interface web como aplicativo móvel.
- **HTML, CSS e JavaScript** na interface localizada em `www/`.
- **Firebase Authentication** para autenticação.
- **Cloud Firestore** para persistência dos dados.
- **Node.js e Express** nos serviços opcionais `backend-chatbot/` e `backend-seguranca/`.
- **OpenAI API** para respostas do chatbot por IA, quando o backend correspondente está configurado.
- **Android Studio / Gradle** para abrir, executar e compilar o aplicativo Android.

## Estrutura do projeto

```text
.
├── android/                 # Projeto Android do Capacitor
├── www/                     # Interface e recursos do aplicativo
├── firebase/                # Regras e documentação do Firestore
├── backend-chatbot/         # Backend opcional do chatbot
├── backend-seguranca/       # Serviço opcional de segurança
├── docs/                    # Documentação do projeto
├── package.json
└── capacitor.config.*
```

A estrutura exata pode variar conforme os arquivos incluídos no repositório.

## Pré-requisitos

Para executar a versão Android, instale:

- [Node.js](https://nodejs.org/)
- [Android Studio](https://developer.android.com/studio)
- Android SDK e os componentes solicitados pelo Android Studio

Também é necessário configurar um projeto Firebase para usar autenticação e banco de dados.

## Instalação e execução

Na raiz do projeto — a pasta que contém `package.json` — execute:

```bash
npm install
```

Configure o Firebase seguindo a próxima seção e, em seguida, sincronize os arquivos web com o projeto nativo:

```bash
npx cap sync android
```

Para abrir o projeto Android Studio:

```bash
npx cap open android
```

No Android Studio, selecione um emulador ou conecte um dispositivo Android com a depuração USB ativada e clique em **Run**.

## Configuração do Firebase

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com/).
2. Em **Authentication**, habilite os métodos de login que deseja disponibilizar, como e-mail/senha e, se configurado, Google.
3. Crie um banco **Cloud Firestore**.
4. Registre um aplicativo Web no projeto Firebase e copie os valores da configuração.
5. Preencha `www/firebase-config.js` com a configuração do seu projeto, mantendo o formato esperado pelo arquivo.
6. Publique as regras de `firebase/firestore.rules` e teste-as antes de usar dados reais.
7. Sincronize novamente o projeto:

```bash
npx cap sync android
```

O aplicativo pode carregar o SDK do Firebase pela internet; portanto, é necessária conexão para os recursos que dependem desses serviços.
