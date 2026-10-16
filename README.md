# BarbTech — Projeto Android (Capacitor)

Este é um projeto **Android Studio real e completo**, já gerado com o app BarbTech
empacotado dentro (tela cheia, sem barra de navegador, ícone e splash screen
personalizados com o tema dourado/preto do app).

## O que já está pronto
- Projeto nativo Android completo em `android/` (Gradle, `AndroidManifest.xml`, etc.)
- Ícone do app (mipmap em todas as densidades) com o "B" dourado
- Splash screen nativa no tema do BarbTech
- `www/index.html` com a interface mobile do BarbTech já embutida
- **Firebase integrado** (`www/app.js`): login e cadastro (Authentication) e dados no Firestore,
  com o app falando direto com o Firebase, sem backend próprio
- App ID: `com.barbtech.app` — Nome: **BarbTech**

## Configurar o Firebase (faça isto antes de rodar)

Sem isto o app abre, mas mostra o aviso "Firebase ainda não configurado".

1. No [console do Firebase](https://console.firebase.google.com), crie um projeto.
2. **Authentication → Método de login** → ative **E-mail/senha**.
3. **Firestore Database → Criar banco de dados** (modo produção; região `southamerica-east1`
   fica mais perto do Brasil).
4. **Firestore Database → Regras** → apague o conteúdo, cole o arquivo
   `firebase/firestore.rules` deste projeto e clique em **Publicar**.
5. **Configurações do projeto** (engrenagem) → **Geral** → **Seus aplicativos** → adicione um
   app **Web** (ícone `</>`, apelido "BarbTech") → copie o objeto `firebaseConfig`.
6. Cole esses valores em `www/firebase-config.js`. O app roda como página web dentro do
   Android, por isso usa o app **Web** do Firebase e **não precisa** do `google-services.json`.
7. Leve a mudança para o Android: `npx cap copy`.

Esses valores não são segredos. Quem protege os dados são as regras do Firestore (passo 4).

**Como o app usa o banco:** o desenho das coleções está em `firebase/firestore_estrutura.md`.
O cliente se cadastra só com e-mail e senha e completa o perfil depois (aba Perfil); o
profissional faz o cadastro completo na hora, e depois cadastra serviços, horários de trabalho
e barbearia no Painel. O cliente só consegue agendar com o perfil completo.

**Atenção:** o app carrega o SDK do Firebase pela internet (CDN do Google) ao abrir, então
precisa de conexão. Depois de qualquer mudança em `www/`, rode `npx cap copy`.

## Como abrir e rodar

### 1. Pré-requisitos (na sua máquina)
- [Android Studio](https://developer.android.com/studio) instalado (ele já vem com o
  Android SDK e o Gradle necessários)
- [Node.js](https://nodejs.org) instalado (para os comandos `npm`/`npx`)

### 2. Instalar as dependências
Abra um terminal **nesta pasta** (a raiz do projeto, onde está o `package.json`) e rode:

```bash
npm install
```

### 3. Abrir no Android Studio
Ainda no terminal, rode:

```bash
npx cap open android
```

Isso abre o Android Studio direto no projeto (pasta `android/`). Na primeira vez,
o Android Studio vai baixar o Gradle e os componentes do SDK que faltarem — pode
levar alguns minutos.

### 4. Rodar no celular ou emulador
- Conecte um celular Android via USB com a **depuração USB** ativada, ou crie um
  emulador pelo próprio Android Studio (Device Manager).
- Clique no botão ▶️ **Run** (ou `Shift+F10`).

### 5. Gerar o APK/AAB para publicar na Play Store
No Android Studio: `Build` → `Generate Signed Bundle / APK`. Escolha **Android App
Bundle (.aab)** (é o formato exigido pela Play Store hoje em dia), crie uma
keystore (chave de assinatura) na primeira vez e guarde-a com cuidado — você vai
precisar dela em toda atualização futura do app.

Para publicar, você precisa de uma conta no
[Google Play Console](https://play.google.com/console) (taxa única de US$ 25).

## Se você editar o app
Sempre que mudar algo em `www/` (`index.html`, `app.js` ou `firebase-config.js`), rode:

```bash
npx cap copy android
```

para levar a mudança ao projeto Android antes de rodar/gerar o build de novo.

## Versão iOS (iPhone)

O projeto iOS já está gerado na pasta `ios/`, mas **só pode ser aberto e compilado em
um Mac** — não existe forma de compilar um app para iPhone em Windows/Linux, isso é
uma exigência da própria Apple.

### Pré-requisitos (num Mac)
- [Xcode](https://apps.apple.com/br/app/xcode/id497799835) instalado (gratuito, via
  Mac App Store)
- Uma **Apple ID** (para rodar no seu próprio iPhone durante testes, uma conta grátis
  já basta — só é paga se você quiser publicar na App Store)

### Passo a passo
1. Na pasta do projeto, rode `npm install` (se ainda não rodou) e depois
   `npx cap open ios` — isso abre o Xcode direto no projeto (`App.xcworkspace`).
2. No Xcode, clique no projeto **App** na barra lateral → aba **Signing & Capabilities**
   → em **Team**, escolha sua Apple ID (se não aparecer, clique em
   "Add an Account..." e faça login com sua Apple ID normal).
3. Conecte o iPhone ao Mac via cabo. No iPhone, quando pedir, toque em **Confiar
   neste computador**.
4. No topo do Xcode, no menu de dispositivos (ao lado do botão ▶️), escolha o seu
   iPhone conectado.
5. Clique em ▶️ **Run**. Na primeira vez, o Xcode instala o app mas o iPhone bloqueia
   a abertura por não confiar no desenvolvedor: vá em **Ajustes → Geral →
   VPN e Gerenciamento de Dispositivo** no iPhone e toque em **Confiar** no seu
   Apple ID. Depois disso o app abre normalmente.
6. Com conta gratuita, o app expira depois de 7 dias e precisa ser reinstalado pelo
   Xcode — normal para testes. Para não expirar (e para publicar na App Store),
   é preciso um [Apple Developer Program](https://developer.apple.com/programs/)
   pago (US$ 99/ano).

### Publicar na App Store
No Xcode: `Product → Archive`, depois usar o **Organizer** para enviar à
**App Store Connect**. Exige a conta paga do Apple Developer Program.

---

## Chatbot (assistente virtual)

O botão redondo dourado no canto da tela (só para **clientes** logados) abre o assistente. Ele tem dois modos:

| Modo | Precisa de backend? | O que faz |
|---|---|---|
| **Botões** (Agendar horário · Ver disponibilidade · Meus agendamentos) | Não | Usa o Firestore do próprio app: mesmos horários, mesmas regras e mesma reserva da tela de agenda |
| **Perguntas digitadas** (IA) | Sim (`backend-chatbot/`) | Responde dúvidas sobre cortes, barba, preços e os seus agendamentos |

Sem o backend o app funciona normalmente: só as perguntas digitadas avisam que ainda não estão ativas.

### Ligar a IA (passo a passo)

1. **Publique o backend** (pasta `backend-chatbot/`) num serviço com HTTPS, por exemplo o Render (Web Service, Node).
   - Build: `npm install` · Start: `npm start`
2. **Variáveis de ambiente** no serviço (use `backend-chatbot/.env.example` como modelo):
   - `OPENAI_API_KEY` = a sua chave (crie uma NOVA no painel da OpenAI)
   - `ALLOWED_ORIGINS` = `https://localhost,capacitor://localhost` (Android e iOS)
   - `TRUST_PROXY` = `1` (no Render/Heroku)
3. **Cole a URL** em `www/chatbot-config.js`:
   ```js
   export const chatbotApiUrl = "https://SEU-BACKEND.onrender.com/api/chat";
   ```
4. Rode `npx cap copy` e gere o app de novo.
