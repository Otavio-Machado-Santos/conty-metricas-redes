# Verificação final da entrega 4

Código revisado: `ebcbf1fbf8f3e9dc206f6a1312ce7e0db283b15c`. Runtime: Node.js 22.23.3 em macOS.

Implementação e documentação: Codex. Revisão: dois agentes Codex independentes do implementador. Não houve revisão humana do código.

- 75 testes passaram no código final; [checkout isolado](evidence/coordenador-clone-limpo.txt).
- [Parecer A](reviews/04-a.json) e [parecer B](reviews/04-b.json), com sondagens independentes, limites e sugestões.
- [Transcrição HTTP real](evidence/coordenador-http.json): 9 etapas verificadas, com requests, respostas e invariantes.
- [Screenshot](evidence/screen.jpg), [resposta expandida](evidence/response.jpg) e [GIF da execução real](evidence/flow.gif).

O GIF foi codificado dos frames de screencast do navegador durante a execução das chamadas locais; não é uma montagem ou simulação. Os dados são fictícios. O portal apenas apresenta respostas da API e compara invariantes. As integrações externas são mockadas quando previsto no enunciado. Os limites de persistência, autenticação e operação estão no README. Os testes e capturas não representam deploy ou funcionamento em produção.

![Respostas reais da API](evidence/screen.jpg)

![Gravação do fluxo HTTP](evidence/flow.gif)
