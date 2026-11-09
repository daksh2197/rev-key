# How this could pay for itself

The web demo is free and stays free. This page is the honest version of how a free demo turns into money, what each path needs to be true, and what I don't know yet.

No market-size numbers here. I haven't measured the market, so I'm not going to make one up.

## Who it's for

People who drive a lot and care how the car sounds:

- Commuters on long highway runs, where the drone is constant for an hour at a time.
- Owners of modified cars, who already paid for the exhaust and want the music to get along with it.
- Sim racers with a wheel on the desk, who get the same thing at home from a game's telemetry.

The moment it's for: cruise, when the engine note settles and the music either fits it or fights it.

## What's free forever

The demo: the counter, the lock, the two placeholder beats, the log replay and the live-car connection. That's how anyone finds out whether their ear hears what mine hears, and charging for it would kill the one thing it's good at: being tried in thirty seconds by someone who has never heard of me.

## Three ways it can earn

### 1. A music pack (digital download)

The demo's two beats are placeholders. A pack is a set of real tracks written to change key on demand: stems delivered in a form the app can shift, in a couple of moods, with the lanes already arranged.

- **Price to test:** a one-time price per pack.
- **What has to be true:** the lock sounds as good on real music as it does on the synth, and people want more than two beats.
- **Cost to deliver:** the music itself, plus per-stem pitch shifting in the app, which is the biggest piece of work on the list.
- **Why first:** it's the thing people ask for the moment the demo works, and it needs no hardware.

### 2. The app, once

A phone app that runs in the background with the screen off: Bluetooth to the adapter, audio to the car. The web demo can't do that; browsers stop audio and Bluetooth when the screen locks.

- **Price to test:** a one-time price. Not a subscription: nobody wants a monthly bill for their car to sound right.
- **What has to be true:** people come back for the second drive. If the demo is a one-time curiosity, the app has no buyer.
- **Cost to deliver:** a native app, store accounts, and the same lock and lane code ported over. The core here is written so that port is a translation, not a rewrite.

### 3. Licensed into dashboards and sims (business-to-business)

The lock and the lanes are a small engine with a clean input (RPM, throttle, speed) and a clean output (key shift, mix, drop time). A dashboard app, a head unit or a racing sim could run it against its own music.

- **Price to test:** a licence per product.
- **What has to be true:** a partner believes it makes their product feel better, and can hear it in a demo.
- **Cost to deliver:** mostly conversations and a tidy package of the core, not code.
- **Why last:** it's the biggest cheque and the slowest yes.

## What it costs to run

| Thing | Cost |
| --- | --- |
| Hosting (GitHub Pages) | $0 |
| Servers, database | none |
| Payment processing | a percentage of each sale, only when there is one |
| App store accounts | yearly fees, only if path 2 happens |

There is no monthly bill to outrun. The break-even for path 1 is the first sale.

## The one-week demand test (before building anything paid)

1. Ship the free demo.
2. Add a "Want real tracks?" link that goes to a waitlist form. Nothing to buy yet.
3. Put the demo in front of drivers: a short video of a real cruise with the lock engaging, posted where sharing a tool is welcome.
4. Count two numbers: clicks on the links I post (a tagged short link per post) and waitlist sign-ups. The demo itself has no tracking and that isn't changing, so I count at the doors, not inside the room.

**Go:** 25 or more sign-ups in a week. Write the first pack.
**No-go:** fewer than 5. The demo is fine, the offer is wrong. Change the offer, not the code.
**In between:** run one more week with a different audience before deciding.

## What I don't know yet

- Whether the lock sounds good on real music or only on a synth built to follow it.
- Whether people hear the clash at all before it's pointed out.
- Whether the pack or the app is the first product. My guess is the pack. A guess is not data.

## Ground rules

- No ads and no selling data. The app doesn't collect any, so there's nothing to sell.
- Anything paid has a refund button.
- It reads from the car and never writes to it, and the volume can only go down from the cap the driver set. Those two stay true in every version, free or paid.
