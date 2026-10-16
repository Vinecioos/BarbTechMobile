# BarbTech - Estrutura do Firestore (fiel ao diagrama de classes)

O ID de cada documento em `clientes`, `profissionais` e `agendas` é o **uid** do Firebase Authentication.
Não existe a coleção `usuarios`: os dados em comum são repetidos em `clientes` e `profissionais`.

## clientes (privado, só o próprio dono lê)

Criado no cadastro só com `perfilCompleto = false`. O restante é preenchido na personalização do perfil.

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
| condicao | string | específico do cliente |
| perfilCompleto | boolean | **extra:** `false` no cadastro, `true` ao terminar o perfil |

## profissionais (público, qualquer logado lê)

| Campo | Tipo | Observação |
|---|---|---|
| nome | string | |
| telefone | string | |
| estado | string | |
| atendeDomicilio | boolean | específico do profissional |
| barbeariaId | string | associação com Barbearia (opcional) |
| sobre | string | **extra:** apresentação (até 280 caracteres) |

### profissionais/{uid}/privado/dados (só o dono lê)

| Campo | Tipo |
|---|---|
| cpf | string |
| cnpj | string |
| logradouroResidencia | string |
| bairroResidencia | string |
| cepResi | string |
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
| enderecoCliente | string | **extra:** só quando `localAtendimento = DOMICILIO` (cópia do endereço do cliente, para o profissional saber aonde ir) |
| status | string | `PENDENTE`, `CONFIRMADO`, `CANCELADO`, `REMARCADO`, `CONCLUIDO` |
| criadoEm | timestamp | |

> Só cliente com `perfilCompleto = true` consegue criar agendamento.

## notificacoes

ID do documento: `<timestamp>_<aleatório>` (assim a ordem dos IDs é a ordem cronológica, já que o diagrama não tem data na notificação).

| Campo | Tipo | Observação |
|---|---|---|
| tipo | string | |
| mensagem | string | |
| agendamentoId | string | relação "gera" |
| destinatarioId | string | uid do cliente que recebe (`enviar(destinatario)`) |

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
