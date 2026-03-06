---
layout: home
title: Code has logic. It does not have meaning.
description: Why repositories need semantic memory, not bigger context windows
date: 2025-03-06
---

<!-- markdownlint-disable MD025 MD026 -->

<div class="vp-essay">
<header class="vp-essay-header">
  <div class="vp-essay-hero">
    <img src="/2025-03-06-code-has-logic-it-does-not-have-meaning.jpg" alt="Code has logic. It does not have meaning." />
  </div>
  <div class="vp-essay-title-block">
    <h1 class="vp-essay-title">Code has logic. It does not have meaning.</h1>
    <p class="vp-essay-subtitle">Why repositories need semantic memory, not bigger context windows</p>
  </div>
</header>
<div class="vp-essay-body">

<!-- markdownlint-enable MD025 MD026 -->

When I enter a new codebase, the first thing I build is not a feature. It is a mental model.
What talks to what. Where the risk sits. Why this module exists. What breaks when it changes.
That model usually does not live in the repository. It lives in Slack threads, meeting notes, old decisions, and in the heads of people who may already be gone.
The code tells you what happens. It rarely tells you why.

Humans can survive that gap. Agents cannot.
A human can ask around, read between the lines, and slowly build a map in their head.
An AI agent processes the text in front of it. If the meaning is missing, it does not magically recover it.
That is why agents often look brilliant on small repos and unreliable on large ones.

The usual explanation is model quality. I do not think that is the real problem.
**The real problem is context shape.**
Give the agent one file and it misses the system around it. Give it the whole repository and it drowns in irrelevant detail.
Too little context breaks neighboring contracts. Too much context turns into noise.
A bigger context window does not fix that. Two hundred thousand tokens of noise is still noise.

That is why I have become skeptical of the current bag of tricks.
Rules files help for a while. Long prompts help for a while. Context dumps help for a while.
Then the project grows. The rules file becomes a junk drawer. The prompt becomes a wall of text. The dump becomes unreadable.
The agent either loads everything or nothing. There is no clean way to say, "give me only the meaning of this part of the system."
**That is not an intelligence problem. It is an information architecture problem.**

---

Most repositories already have one kind of memory. Git gives them memory of changes.
It remembers who changed what, when, and how.
What it does not remember is what the system is, why a rule exists, what a module is responsible for, what constraints apply here, or what else breaks when an interface changes.
That knowledge exists in real teams. It is just scattered, implicit, or gone.

That missing layer matters more now because agents are part of the team.
A human joining a project can ask a senior engineer, "Why is this weird rule here?"
An agent cannot DM your former teammate from two years ago.
It will either guess, fail, or keep asking you until you become the context window.

That is the idea that pushed me into building Yggdrasil.
Not as a code generator. Not as a graph database. Not as another documentation ritual for humans.
**As semantic memory for a repository.**

---

The implementation is deliberately boring. Plain Markdown. Plain YAML. A .yggdrasil/ folder inside the repo.
Inside it, the repository stores a structured map of modules, responsibilities, interfaces, constraints, cross cutting aspects, and end to end flows.
The goal is simple. Before an agent touches code, it should get the right slice of meaning for the thing it is about to change.

That slice should be small.
This is the part I think people still underestimate.
Good context is not a giant dump. Good context is a bounded package with the exact information needed for one unit of work.
In Yggdrasil, that package can include the unit's responsibility, its interface, the constraints that apply to it, the interfaces of its dependencies, and the business flow it participates in.
**The whole point is to give the agent 2,000 useful tokens instead of 200,000 random ones.**

This changes the question from "how do we show the model more of the repo?" to "how do we make the repo legible?"
Those are not the same thing.
A codebase can be fully visible and still semantically opaque.
You can index every symbol and still not know what a service is actually responsible for, what business rule matters here, or what else is affected by a change.
Search answers "where is X." It does not reliably answer "what is X for" or "what breaks if I change it."

I also think this is where flat rules files hit the wall.
They are global. They are not queryable per unit. They have no real layering. They do not validate themselves.
Global standards sit next to a detail from one service, and the agent gets both with the same weight.
That is like handing someone a map, a grocery list, three meeting notes, and a fire drill manual, then acting surprised when they still miss the turn.

The repository needs a map. Not just a compass.
A compass tells you a direction. A map tells you what exists, what connects to what, and what terrain you are standing on.
That is how I think about semantic memory. Not as more advice for the agent, but as navigable structure.

There is another reason I like this model. It creates a stronger feedback loop than traditional documentation.
Normal docs rot because people stop reading them and stop updating them.
Agent facing semantic memory has a harsher test. If it is wrong, the output gets worse immediately.
Bad memory produces bad code. That is painful enough to force maintenance.
In Yggdrasil's model, code and graph are one unit of work. Change one without the other and you create drift.

Drift is not a corner case. It is normal life.
People hotfix things. They experiment. They edit code directly. They forget to update the knowledge around it.
So the system has to treat drift as first class, detect it, and force a decision.
Either the graph absorbs reality, or the output gets brought back in line with the graph.

I do not think adoption can be all or nothing either.
A project with 500 files should not need to model the entire world before getting value.
It should start where the pain is.
One bad module. One area where the agent keeps making the same mistake. One place where people keep re explaining the same decision.
Coverage can grow where the work is happening.

---

Now for the honest part.
This does not replace source code.
And it does not help equally in every situation.
In my experiments, the real advantage of a semantic graph is cross module reasoning.
It helps when the question is "why was this designed this way?", "what else is affected by this change?", or "how does this business flow work end to end?"
That is where declared relations, shared constraints, and flows create actual leverage over raw file reading.

But if I need to know the exact failure behavior of a call, the exact await pattern, the exact transaction boundary, or whether a feature exists in the implementation right now, I trust the code first.
That was one of the most useful findings.
**The graph is strongest at why, should we, and what else. The code is strongest at what exactly happens here.**
Those are complementary knowledge sources. Treating one as a replacement for the other is a mistake.

Another uncomfortable result is that agents are much better at spotting contradictions than omissions.
If the graph says something false and the code says something else, they often catch it.
If an important rule is simply missing from the graph, they are much worse at noticing the absence.
That means incompleteness is more dangerous than inconsistency, because the agent can confidently reason from a map that has a hole in it.
So the hard part is not just keeping semantic memory correct. It is keeping it complete enough where it matters.

Even with those limits, I think agents make one thing impossible to ignore.
A huge amount of the value in a software system has never lived in code.
It lives in responsibility boundaries, business rules, rejected alternatives, architecture constraints, and the reason a strange decision was made six months ago.
Humans carried that in their heads because they had to.
Now we work with tools that cannot survive on tacit knowledge.

That is why I do not think the answer is more vibes, longer prompts, or blind faith that the next model will infer the whole system from raw files.
I think the answer is to give the repository a second memory.
**Git remembers changes. The repository should also remember meaning.**
If it does, the next engineer does not have to rebuild the whole map from scratch.
And the next agent does not have to guess why the road bends there in the first place.

</div>
</div>
