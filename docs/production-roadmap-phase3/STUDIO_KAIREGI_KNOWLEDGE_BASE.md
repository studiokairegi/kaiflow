# Studio Kairegi Knowledge Base: status and what the owner must supply

The knowledge base is the `intel_kb` table, edited in Intelligence > Settings > Knowledge base. **Only rows the administrator approves are ever used**, and editing a row un-approves it. I cannot see or approve your live rows, and I did not invent business facts. Nothing below is loaded for you.

## Facts you have stated (propose these as entries; you approve them)
| Suggested key | Kind | Content you stated |
|---|---|---|
| `studio.positioning` (or fold into `studio.about`) | studio | Primary: anime-style 2D animation studio for indie game developers. Secondary: animation production outsourcing and support for studios. |
| `policy.identity` | policy | Present Studio Kairegi as a studio, not an individual freelancer. |
| `policy.samples` | policy | Do not offer unpaid samples. |
| `policy.commitments` | policy | Do not invent client requirements, production capacity or pricing commitments. |

(The identity, samples and commitments rules are also hard-coded into the chat prompt, so they hold even if the KB is empty.)

## Entries the roadmap asks for that need your text
The composer already requires `studio.about`, `services.indie_game_developer`, `services.animation_studio_support`, `portfolio.main` (and `.ja` variants for Japanese outreach). For Agent Chat to answer practical questions, add and approve:
- `services.*`: what you actually offer (anime-style 2D animation, indie game animation support, animation outsourcing), in your words.
- `pricing.principles` (kind `pricing_guidance`): principles and scope boundaries only, if you want the assistant to describe them.
- `capabilities.production`: production capabilities and what you do not do.
- `availability.current` (kind `availability`): only if you want it stated; it goes stale.
- `outreach.preferences` (kind `policy` or `template`): tone, language, cadence preferences.

## What the assistant does with gaps
If an answer is not in approved entries it must say it is not on file and name Settings > Knowledge base. Verified by mocked prompt tests only (see test results); real model behaviour is not yet evaluated.
