"""Cálculo de cuánto pagó cada uno y quién le debe a quién para quedar parejos."""


def build_summary(users, paid_by_user_id):
    """
    users: lista de dicts {"id": int, "name": str}
    paid_by_user_id: dict {user_id: total_pagado_en_items_incluidos}

    Devuelve un dict con el total compartido, la parte justa por persona,
    el balance de cada uno y la lista mínima de pagos para saldar cuentas.
    """
    n = len(users)
    total_shared = round(sum(paid_by_user_id.get(u["id"], 0.0) for u in users), 2)
    fair_share = round(total_shared / n, 2) if n else 0.0

    balances = []
    for u in users:
        paid = round(paid_by_user_id.get(u["id"], 0.0), 2)
        balance = round(paid - fair_share, 2)
        balances.append(
            {
                "user_id": u["id"],
                "name": u["name"],
                "paid": paid,
                "fair_share": fair_share,
                "balance": balance,  # positivo = le deben, negativo = debe
            }
        )

    settlements = _simplify_debts(balances)

    return {
        "total_shared": total_shared,
        "fair_share": fair_share,
        "balances": balances,
        "settlements": settlements,
    }


def _simplify_debts(balances, epsilon=0.01):
    """Algoritmo greedy: empareja al mayor deudor con el mayor acreedor
    hasta saldar todas las cuentas con el menor número de pagos posible."""
    creditors = sorted(
        [dict(b) for b in balances if b["balance"] > epsilon],
        key=lambda x: -x["balance"],
    )
    debtors = sorted(
        [dict(b) for b in balances if b["balance"] < -epsilon],
        key=lambda x: x["balance"],
    )

    settlements = []
    i, j = 0, 0
    while i < len(debtors) and j < len(creditors):
        debtor = debtors[i]
        creditor = creditors[j]
        amount = round(min(-debtor["balance"], creditor["balance"]), 2)

        if amount > epsilon:
            settlements.append(
                {"from": debtor["name"], "to": creditor["name"], "amount": amount}
            )
            debtor["balance"] = round(debtor["balance"] + amount, 2)
            creditor["balance"] = round(creditor["balance"] - amount, 2)

        if abs(debtor["balance"]) <= epsilon:
            i += 1
        if abs(creditor["balance"]) <= epsilon:
            j += 1

    return settlements
