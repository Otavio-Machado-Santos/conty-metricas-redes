# Métricas das redes do criador

API Node.js 22 com um provedor simulado para Instagram, TikTok, YouTube e X. Recebe uma conexão já autorizada, busca snapshots absolutos dos posts e preserva idempotência em repetições, janelas sobrepostas e chamadas concorrentes. O [enunciado](docs/enunciado.txt) é o contrato.

## Executar

```sh
node --version  # v22.x
npm test
npm start
```

Não há dependências externas nem etapa de build. O servidor escuta somente `127.0.0.1:3004`; `PORT` altera a porta. Abra [a demonstração local](http://127.0.0.1:3004/demo), que chama a API real com dados fictícios. Em outro terminal, `npm run demo` reproduz o mesmo fluxo HTTP. A transcrição verificável dos testes está em [docs/evidence/test.txt](docs/evidence/test.txt).

## Contrato HTTP

Todo corpo usa `Content-Type: application/json`; limite de 64 KiB, campos desconhecidos rejeitados. Identificadores têm 1 a 128 caracteres alfanuméricos, `.`, `_`, `:`, `-`. Instantes exigem ISO 8601 com fuso explícito e são normalizados para UTC. Uma janela inclui ambos os limites, precisa ter `from <= to` e não pode terminar no futuro.

| Método e rota | Entrada / saída |
| --- | --- |
| `POST /connections` | `id` opcional, `creator_id`, `network`, `account_id`, `token`, `simulation` opcional. HTTP 201, identidade pública e `authorized: true`; token nunca é devolvido. |
| `GET /connections` | Conexões, `created_at` e `last_sync_at`, sem tokens. |
| `POST /connections/:id/sync` | `{ "from": "...", "to": "..." }`. Tentativas, esperas solicitadas, `fetched_at`, novos snapshots, duplicatas, dados fora da janela, posts e totais atuais. |
| `GET /connections/:id/posts` | Uma entrada por post, última medição e `snapshot_count`; totais das últimas medições. |
| `GET /connections/:id/posts/:post_id` | Última medição e histórico cronológico de snapshots únicos. |
| `GET /health` | Disponibilidade do processo; não significa integração com uma rede real. |

Exemplo executável, com apenas token fictício:

```sh
curl -sS http://127.0.0.1:3004/connections \
  -H 'Content-Type: application/json' \
  -d '{"id":"demo","creator_id":"criador-1","network":"instagram","account_id":"conta-demo","token":"ficticio","simulation":"rate-limit-once"}'

curl -sS http://127.0.0.1:3004/connections/demo/sync \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-06-01T09:00:00Z","to":"2026-06-01T10:59:59Z"}'

curl -sS http://127.0.0.1:3004/connections/demo/sync \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-06-01T10:00:00Z","to":"2026-06-01T11:00:00Z"}'

# Repetir o último POST: new_snapshots=0, duplicates=3; totals.views continua 210.
curl -sS http://127.0.0.1:3004/connections/demo/posts/post-1
```

A primeira busca recebe 429, espera 1000 ms e retorna `attempts: 2`, `new_snapshots: 2` e `totals: { "views": 160, "likes": 18, "comments": 3 }`. A segunda tem `new_snapshots: 1`, `duplicates: 2` e totais 210/22/4. O histórico do post-1 tem duas medições, 100 e 150 views; o total atual usa 150, sem somar 100 + 150. Os horários de `fetched_at` dependem da execução.

Erros seguem `{ "error": { "code": "...", "message": "..." } }`, com detalhes de tentativas e espera quando aplicável. Principais status: 400 entrada/janela inválida, 404 conexão/post/rota ausente, 409 identidade ou conta já registrada, 413 corpo grande, 415 Content-Type, 429 limite de taxa, 502 falha/resposta inválida do provedor, 504 timeout esgotado. Texto bruto do provedor não é exposto.

## Idempotência e atualização

O armazenamento usa `(network, account_id, post_id, observed_at)` como identidade. Mesmo instante com o mesmo conteúdo não acrescenta histórico nem contadores. Fusos diferentes que representam o mesmo instante resultam na mesma chave. `first_fetched_at` preserva a primeira busca; `fetched_at` informa a última busca daquele snapshot. `last_sync_at` da conexão informa o último sync bem-sucedido, inclusive quando não há novos dados.

Cada post tem uma medição atual: o maior `observed_at`, independentemente da ordem de chegada. Medição antiga não regride o estado atual. Uma medição nova com um contador menor pode representar correção legítima do provedor; por isso a regra usa tempo, não o maior número já visto. Totais somam somente a última medição de cada post. A resposta pode trazer mais de um snapshot do mesmo post sem contar esse post duas vezes nos totais.

Um lote é validado e aplicado atomicamente em memória. Mesmo post/instante com contadores diferentes é conflito 502 e não grava parcialmente; não há escolha silenciosa de qual resposta venceu. Snapshots válidos fora da janela são ignorados e contados em `outside_window`. Contadores exigem inteiros não negativos com precisão segura; soma sem precisão segura também falha antes da escrita. Limite de 10.000 snapshots por resposta.

Uma conta de uma rede tem só uma conexão. Filas por conta serializam syncs concorrentes; contas diferentes são independentes. Isso evita escrita concorrente e preserva o cooldown de taxa entre chamadas. Os testes cobrem repetição, sobreposição, medição atrasada, conflito e concorrência.

## Retry, timeout e Retry-After

Defaults: até **3 tentativas**, timeout de **1000 ms por tentativa**, espera máxima de **2000 ms por prazo de retry**, backoff inicial **100 ms**. Variáveis `MAX_ATTEMPTS`, `REQUEST_TIMEOUT_MS`, `MAX_WAIT_MS`, `BASE_DELAY_MS` alteram esses valores; valores inválidos impedem iniciar. [.env.example](.env.example) documenta os nomes; o processo não lê esse arquivo automaticamente. Também é possível injetar `policy` no construtor de `MetricsService`.

Timeout, HTTP 408, 429, 5xx ou `ProviderError` explicitamente transitório podem repetir. Outros erros encerram a busca. No último erro não há espera inútil nem quarta tentativa. Timeout usa corrida com temporizador, envia `AbortSignal` e limpa o timer. O adaptador real deverá respeitar esse signal; um adaptador que o ignore pode continuar usando seus próprios recursos, embora não possa escrever no store nem prender a espera do serviço.

429 aceita `Retry-After` em segundos inteiros ou HTTP-date UTC (incluindo formatos históricos). O relógio calcula o intervalo restante; prazo vencido ou zero permite tentar imediatamente. Header ausente ou inválido usa backoff exponencial limitado. Backoff de falhas transitórias também é limitado pelo teto.

**Se Retry-After exceder o teto, o serviço adia e responde 429**, com `retry_after_ms` e header `Retry-After`. Não dormir menos que o provedor mandou e tentar cedo é a decisão que resolve as duas restrições do enunciado. O cooldown fica registrado por conta: outra chamada antes do prazo também é adiada; quando faltar até o teto, o serviço espera o restante e retoma. Um prazo que não cabe na representação numérica permanece adiado, com `retry_after_ms: null`, exigindo intervenção no adaptador. A espera é um prazo por retry, não um orçamento total da sincronização; cada tentativa e cada prazo têm seus tetos. `waits_ms` registra as esperas solicitadas ao sleeper, que pode precisar completar um prazo se acordar cedo.

`now`, `sleeper` e o executor de timeout são injetáveis. Os testes avançam o relógio, verificam cada espera e acionam temporizadores sem aguardar segundos reais. Os testes HTTP abrem sockets locais e usam o mesmo serviço/provedor, com relógio controlado. `npm run demo` e `/demo` usam tempo real.

## Fronteira do provedor e decisões

Comece por [src/service.js](src/service.js) (orquestração), [src/retry.js](src/retry.js) (política) e [src/store.js](src/store.js) (invariantes). [src/http.js](src/http.js) traduz o contrato HTTP. [src/providers/simulated.js](src/providers/simulated.js) é o único adaptador; recebe `fetchPosts({ connection, from, to, signal })` e retorna `{ post_id, observed_at, views, likes, comments }[]`, ou lança `ProviderError` com status/Retry-After/transitoriedade. O provedor não conhece o store; a regra de negócio não conhece Instagram/TikTok/YouTube/X ou HTTP de terceiros.

Simulações: `normal`, `duplicate`, `timeout-once`, `always-timeout`, `rate-limit-once`, `rate-limit-date`, `rate-limit-too-long`, `server-error-once`. As falhas “once” acontecem na primeira chamada daquela conexão. Os dados sintéticos fixos têm dois posts e três snapshots em 1 de junho de 2026. Cada conta usa o mesmo cenário de dados isolado. Não são métricas reais.

Estado e cooldown são em memória e se perdem ao reiniciar. OAuth, autenticação da API, cofre de tokens, persistência distribuída, paginação de provedores reais e execução em múltiplos processos ficam fora deste protótipo. Para produção, a chave única, a transação e o lock/cooldown por conta precisam de armazenamento compartilhado. O limite por resposta não é retenção histórica: uma política de retenção/paginação será necessária para longo uso. Mantive essas fronteiras explícitas para que o exercício seja reproduzível sem contas externas ou credenciais reais.

## Validação e uso de IA

`npm test` valida invariantes de idempotência/atomicidade, concorrência, separação de contas, validação de entrada/resposta, retries/timeout/429 e fluxo HTTP completo. [test/idempotency.test.js](test/idempotency.test.js), [test/retry.test.js](test/retry.test.js), [test/cooldown.test.js](test/cooldown.test.js) e [test/http.test.js](test/http.test.js) organizam os cenários. [docs/demo.http](docs/demo.http) é o roteiro de requests para captura real.

Codex produziu código, testes e documentação. Dois agentes Codex independentes do implementador revisaram o commit `ebcbf1fbf8f3e9dc206f6a1312ce7e0db283b15c` e liberaram a entrega após testes e sondagens próprias. Os pareceres completos estão em `docs/reviews/`. O coordenador conferiu a instalação e os testes em checkout isolado e registrou o fluxo HTTP real. Não foi realizada revisão humana do código. A validação usa dados sintéticos e ambiente local; limites e interpretações do contrato estão documentados.

[Verificação final, revisões independentes e captura do fluxo real](docs/verificacao-final.md).
