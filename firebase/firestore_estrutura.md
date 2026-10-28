# BarbTech - Estrutura do Firestore (fiel ao diagrama de classes)

O ID de cada documento em `clientes`, `profissionais` e `agendas` é o **uid** do Firebase Authentication.
Não existe a coleção `usuarios`: os dados em comum são repetidos em `clientes` e `profissionais`.

## clientes (privado, só o próprio dono lê)

Criado na tela de cadastro do cliente (já completo, `perfilCompleto = true`); em contas antigas nasce com `false` e é completado no Perfil.

| Campo | Tipo | Observação |
|---|---|---|
| nome | string | |
| telefone | string | |
| estado | string | |
| cpf | string | |
| cnpj | string | |
| logradouroResidencia | string | |
| bairroResidencia | string | |
| cepResi | string | |
| complementoResidencia | string | |
| cidadeResidencia | string | **extra:** conferida com o CEP |
| condicao | string | específico do cliente (até 200 caracteres) |
| perfilCompleto | boolean | **extra:** `false` no cadastro, `true` ao terminar o perfil |
| fotoUrl | string | **extra:** foto de perfil reduzida (data URL JPEG, até ~45 mil caracteres) |
| lat, lng | number | **extra:** posição calculada pelo CEP (privada, só o dono lê) |

Subcoleção `clientes/{uid}/midia/banner` → `{ dataUrl }` (banner, só o dono lê).

## profissionais (público, qualquer logado lê)

| Campo | Tipo | Observação |
|---|---|---|
| nome | string | |
| telefone | string | |
| estado | string | |
| atendeDomicilio | boolean | específico do profissional |
| barbeariaId | string | associação com Barbearia (opcional) |
| fotoUrl | string | **extra:** foto de perfil reduzida (data URL JPEG) |
| taxaDomicilio | number | **extra:** taxa de deslocamento definida pelo profissional (R$) |
| lat, lng | number | **extra:** posição **aproximada (~1 km)** calculada pelo CEP, para a distância |

Subcoleção `profissionais/{uid}/midia/banner` → `{ dataUrl }` (qualquer logado lê, só o dono grava).
| sobre | string | **extra:** apresentação (até 280 caracteres) |

### profissionais/{uid}/privado/dados (só o dono lê)

| Campo | Tipo |
|---|---|
| cpf | string |
| cnpj | string |
| logradouroResidencia | string |
| bairroResidencia | string |
| cepResi | string |
| cidadeResidencia | string |
| complementoResidencia | string |

## agendas (1:1 com o profissional, ID = uid dele)

| Campo | Tipo | Observação |
|---|---|---|
| profissionalId | string | |
| horarios | map | **extra:** horário de trabalho por dia (`seg`…`dom`), cada um `{aberto: boolean, inicio: "HH:mm", fim: "HH:mm"}`. É o que gera os horários livres do calendário (`gerenciarAgenda()`) |

## barbearias

| Campo | Tipo | Observação |
|---|---|---|
| nome | string | |
| logradouro | string | |
| bairro | string | |
| complemento | string | |
| cnpj | string | |
| cep, cidade, estado | string | **extra:** endereço completo, mostrado ao cliente no agendamento |
| donoId | string | **extra:** uid do profissional que criou (usado nas regras) |

## servicos

| Campo | Tipo |
|---|---|
| profissionalId | string |
| nome | string |
| duracaoMin | number |
| precoBase | number |

## agendamentos

| Campo | Tipo | Observação |
|---|---|---|
| localAtendimento | string | `BARBEARIA` ou `DOMICILIO` |
| clienteId | string | |
| clienteNome | string | **extra:** cópia, para o profissional ver sem ler `clientes` |
| data | string | `AAAA-MM-DD` |
| horario | string | `HH:mm` |
| profissionalId | string | |
| servicoId | string | |
| agendaId | string | igual ao uid do profissional (agregação na Agenda) |
| servicoNome, duracaoMin, valorServico, valorDeslocamento, valorTotal | string/number | **extra:** cópia do que foi contratado (base do faturamento no BI) |
| iniciadoEm, concluidoEm | number | **extra:** milissegundos; "Iniciar" e "Concluir" do profissional |
| duracaoReal | number | **extra:** minutos reais do atendimento (concluidoEm − iniciadoEm) |
| enderecoCliente | string | **extra:** só quando `localAtendimento = DOMICILIO` (cópia do endereço do cliente, para o profissional saber aonde ir) |
| status | string | `PENDENTE`, `CONFIRMADO`, `CANCELADO`, `REMARCADO`, `CONCLUIDO` |
| criadoEm | timestamp | |
| enderecoLocal | string | **extra:** endereço da barbearia no momento do agendamento (`BARBEARIA`) |
| enderecoCliente | string | **extra:** casa do cliente (`DOMICILIO`) |
| condicaoCliente | string | **extra:** condição do cliente, só em `DOMICILIO` |
| precoOriginal, desconto, promocaoId, promocaoTitulo | number/string | **extra:** quando houve promoção |
| servicoNome, duracaoMin, valorServico, valorDeslocamento, valorTotal | | **extra:** cópia do que foi contratado (BI) |

> Só cliente com `perfilCompleto = true` consegue criar agendamento.

## notificacoes

ID do documento: `<timestamp>_<aleatório>` (assim a ordem dos IDs é a ordem cronológica, já que o diagrama não tem data na notificação).

| Campo | Tipo | Observação |
|---|---|---|
| tipo | string | |
| mensagem | string | |
| agendamentoId | string | relação "gera" |
| destinatarioId | string | uid do cliente que recebe (`enviar(destinatario)`) |

## dispositivos (extra, notificação push)

ID: `uid_hash`. Campos: `uid`, `token` (FCM do celular), `plataforma`, `atualizadoEm`. Só o dono lê/grava; a Cloud Function `enviarPush` (pasta `functions/`) lê para enviar o aviso quando nasce uma `notificacoes`.

## promocoes (extra): destaques do profissional

| Campo | Tipo | Observação |
|---|---|---|
| profissionalId | string | dono |
| tipo | string | `PROMOCAO` ou `NOVIDADE` |
| titulo | string | até 60 caracteres |
| descricao | string | até 200 caracteres |
| desconto | number | % (0 para novidade) |
| servicoId | string/null | null = todos os serviços |
| validaAte | string | `AAAA-MM-DD` |
| ativa | boolean | |
| criadoEm | timestamp | |

## horariosOcupados (extra, não existe no diagrama)

ID do documento: `profissionalId_AAAAMMDD_HHmm` (ex.: `abc123_20261015_1430`).
A agenda é dividida em blocos de **30 minutos**: um serviço de 45 min ocupa 2 blocos (2 documentos), um de 75 min ocupa 3.

| Campo | Tipo |
|---|---|
| profissionalId | string |
| clienteId | string |
| agendamentoId | string |

> O Firestore não tem `UNIQUE`. Como esse documento só pode ser criado (nunca alterado), dois clientes não conseguem reservar o mesmo horário: se um bloco já existe, o `batch` inteiro é recusado. O app grava `agendamentos`, `horariosOcupados` e as notificações juntos em um **WriteBatch**, e apaga os blocos ao cancelar ou remarcar.

## Resumo do que NÃO está no diagrama
- `perfilCompleto` (clientes), `donoId` (barbearias), `clienteNome` e `enderecoCliente` (agendamentos), `sobre` (profissionais), `horarios` (agendas), a coleção `horariosOcupados` e a subcoleção `privado` (profissionais).
- Todos existem por causa do Firestore (sem joins, sem UNIQUE, regras de segurança), do fluxo de cadastro ou das telas do app (horários de trabalho, "sobre mim", atendimento em casa).
- `data` e `horario` são guardados como texto, e não como datetime.
- O valor do deslocamento do atendimento em casa (R$ 22) fica no código do app (`TAXA_DOMICILIO` em `www/app.js`), não no banco.

## Fluxo no app
1. **Cadastro:** o usuário escolhe "Sou cliente" ou "Sou profissional" e informa e-mail e senha (Firebase Authentication).
   - Cliente: grava `clientes/{uid}` com `perfilCompleto: false`.
   - Profissional: grava `profissionais/{uid}`, `profissionais/{uid}/privado/dados` e `agendas/{uid}`.
2. **Login:** o app vê qual documento existe para o uid (`clientes` ou `profissionais`) e abre a tela correspondente.
3. **Cliente novo:** se `perfilCompleto == false`, vai para a personalização do perfil, e ao salvar muda para `true`.

## Novidades da versão 6 (segurança e LGPD)

A coleção consentimentos guarda, com o uid do usuário como ID do documento, a versão da política de privacidade aceita, a data do aceite, e duas permissões booleanas: localizacao (uso do CEP para distância e filtro por região) e condicao (compartilhar a condição do cliente com o profissional). Só o dono lê, grava e apaga.

As coleções codigoRec, otp, tentativasLogin e auditoria pertencem ao serviço backend-seguranca. As regras negam qualquer acesso vindo do aplicativo; só o Admin SDK do servidor lê e escreve nelas. Essas três coleções só são usadas se você subir o serviço opcional (OTP por e-mail, bloqueio no servidor e auditoria). A coleção otp guarda apenas o hash do código enviado por e-mail, a validade e o número de tentativas.

Os perfis, a área privada do profissional, a agenda, o banner e o consentimento agora podem ser apagados pelo próprio dono (direito de eliminação da LGPD). Os agendamentos continuam sem exclusão.

Leitura por perfil: clientes leem os perfis, serviços, agendas, promoções, banners e barbearias dos profissionais (é assim que escolhem quem os atende). Um profissional não lê o perfil de outro: ele só lê os próprios documentos e a barbearia da qual é dono.


A coleção recuperacao guarda o cofre do código de recuperação e funciona sem servidor próprio. O ID do documento é o e-mail da conta em minúsculas. O documento tem os campos uid, v, sal, iv, ct e criadoEm: ct é a senha da conta criptografada no aparelho (AES-256-GCM) com uma chave derivada do código de recuperação (PBKDF2-SHA256, 600 mil voltas), sal e iv são valores aleatórios da criptografia. O código e a senha nunca são gravados em texto aberto. As regras permitem que qualquer pessoa leia um cofre se souber o e-mail (é assim que a recuperação funciona antes do login), mas ninguém lista a coleção, e só o dono da conta cria, troca ou apaga o próprio cofre. Contas que entram com o Google não têm cofre. Ao excluir a conta, o cofre é apagado.

Todos os campos de texto têm limite de tamanho, tanto no aplicativo (atributo maxlength e sanitização) quanto nas regras do Firestore (função limites): nome 80, telefone 20, CPF 14, CNPJ 18, CEP 9, cidade e bairro 60, rua 100, complemento 60, condição 200, sobre 500. O CPF e o CNPJ têm os dígitos verificadores conferidos no aplicativo; as regras do Firestore conferem só o tamanho.
