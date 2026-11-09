---
name: maya-session
description: Work with a running Maya session — see what the agents are doing, post to the shared chat, reach the person directly, and answer the Operator's merge questions. Use when the repository has a .maya directory, when asked to check on or report to a Maya session, or when a task mentions Maya, the Operator, or worker agents.
---

# Working inside a Maya session

Maya runs several AI coding CLIs against one git repository under an
**Operator** that assigns tasks and is the only thing that merges. A person
watches it from terminal panes and a web interface, both reading one shared
event log.

If this repository has a `.maya/` directory, you may be working alongside
that. These tools let you take part rather than work past it.

## Find out where things stand first

```
maya_session          the repository, the branch, whether the tree is clean, the agents
maya_recent_activity  the last entries of the shared log — what has already been tried
maya_tasks            every task and its state
```

Call `maya_session` before anything else. It also tells you whether a session
is running at all: if it is not, the tools say so and say how to start one,
and you should carry on with your own work rather than trying to start one
yourself.

**Read `maya_recent_activity` before you change anything.** Another agent may
be part-way through the same file on its own branch. The log is how you find
that out.

## Say what you are doing

```
maya_say   posts to the shared chat
```

The person sees it live in their panes and in the browser, and it stays in
the session log. Worth doing when you start something substantial, when you
find something that changes the picture, and when you finish.

Keep it to what another reader needs: what you did and what it means. Not a
running commentary.

## Reach the person directly

```
maya_tell_user   the secret channel, straight to them
```

This bypasses the Operator's transcript and lands in a panel of its own. It is
for a decision only they can make, or a detail without which your work would
be guesswork — an ambiguous spec, two plausible readings of a requirement,
something that looks like a credential.

It interrupts a person. Use `maya_say` for anything that can wait.

## Answer the Operator

```
maya_pending_question   what it is waiting on, and the options
maya_answer_question    an option number, or your own words
```

The Operator asks when it cannot merge on its own — usually two branches
touching the same lines. The same question is on the person's screen in two
places while you look at it.

**Do not answer on their behalf unless they asked you to.** An answer decides
what happens to a branch, and "abandon this branch" throws work away. If you
were not asked to decide, use `maya_tell_user` to say the question is waiting
and leave it.

## What these tools will not do

There is no tool to queue work for the agents. The Operator runs the task list
it was given when the session started, so a task added from outside would
appear in the panel and then never run. To get work done, ask the person to
run `maya start "<task>"`, or do it yourself in the ordinary way.
