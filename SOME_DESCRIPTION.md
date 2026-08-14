An interactive page where the mixed Nash equilibrium of a 2×2 game is something you **look at** rather than something you solve for.

**Try it:** [nash-equilibrium-simulator.com](https://nash-equilibrium-simulator.com/) — a guided walkthrough starts automatically, moves the camera for you, and points arrows at what matters. You can grab the graph and rotate it at any time.

## The question

Two people choose at the same time, neither seeing the other. Sometimes there is no best choice — only a best *proportion*. The usual algebraic recipe gives you that proportion, but never says what the number **is**, or why it lands where it does.

## Drawing the game

Let $x$ be the probability the first player picks their first option, $y$ the same for the second. With payoffs $a_{ij}$, the first player's expected payoff across every pair of mixes is

$$E_A(x,y) = a_{11}xy + a_{12}x(1-y) + a_{21}(1-x)y + a_{22}(1-x)(1-y)$$

which tidies to

$$E_A = T_A\,xy + (a_{12}-a_{22})x + (a_{21}-a_{22})y + a_{22}, \quad T_A = a_{11}-a_{12}-a_{21}+a_{22}$$

Everything is linear except the single $xy$ term, so the surface is **straight along each axis** and bends only through that one cross term. $T_A$ is the entire strategic interaction in one number: at zero the surface is a flat plane and what your opponent does cannot change what is best for you.

Plot $E_A$ and $E_B$ over the unit square. Every cell of the payoff table is one corner.

## Indifference is a flat line

Fix the opponent at some $y$ and look along your own axis. $E_A$ is linear in $x$, a straight line of slope

$$\frac{\partial E_A}{\partial x} = T_A\,y + (a_{12}-a_{22})$$

which vanishes at exactly one value:

$$y^{*} = \frac{a_{22}-a_{12}}{T_A}$$

There the line is **level** — every mix pays the same. Indifference isn't an abstraction here; it's a flat line you can see, and you can slide the opponent's probability until it flattens. The mixed equilibrium is where *both* surfaces go level at once: the joint flat spot.

## The strange part

Run the same derivative for the second player:

$$x^{*} = \frac{b_{22}-b_{21}}{T_B}, \qquad y^{*} = \frac{a_{22}-a_{12}}{T_A}, \qquad T_B = b_{11}-b_{12}-b_{21}+b_{22}$$

Look at whose numbers appear where. **$x^{*}$ — the first player's own mixing probability — is built entirely from the second player's payoffs.** Their own payoffs appear nowhere in it.

So your equilibrium mixture does no job for you. It does one for your opponent: it is the unique mix holding *them* perfectly balanced, and theirs does the same for you. Someone following only their own incentives would never arrive at it — which is exactly why it resists intuition.

## Why "take the best option" can't get there

For fixed $y$, $E_A$ is linear in $x$, so it is maximised at an endpoint — $x=0$ or $x=1$ — unless the slope is exactly zero, which happens only at $y = y^{*}$.

So **a best response is always a pure strategy**. Self-interest alone can only point at a corner, and can never name an interior point. The page shows one way to close the gap: each player carries a boundary of mixes still worth considering, and it contracts as the opponent's regret falls. The restriction is what makes convergence possible.

## The two games

| | Prisoner's Dilemma | Spy vs. Analyst |
|---|---|---|
| Row payoffs | `[[3, 0], [5, 1]]` | `[[1, -2], [-3, 4]]` |
| Twist $T_A$ | $-1$ | $10$ |
| $y^{*}$ | $-1$ — **off the board** | $3/5$ |
| Equilibrium | a corner: both confess | interior: $(7/10,\ 3/5)$ |

The dilemma comes first on purpose. Its $y^{*}$ lies outside $[0,1]$, so its surface never levels anywhere on the board — nothing to balance, no reason to mix, and the equilibrium is stuck in a corner worse for both than the one they can't reach. That contrast is what the mixed case needs.

## What you can do

- **Type in your own payoffs** and watch the flat spot move — or vanish, if you remove the twist.
- Run the dynamics from any starting point and watch the corridor contract.
- Rotate, pan and zoom freely; skip the walkthrough whenever you like.

Every equilibrium shown is computed exactly by a solver property-tested against randomly generated games, so the picture and the arithmetic cannot drift apart.
