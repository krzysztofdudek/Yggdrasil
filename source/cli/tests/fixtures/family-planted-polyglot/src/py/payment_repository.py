class PaymentRepository:
    def __init__(self):
        self.rows = []

    def add(self, value):
        self.rows.append("payment:" + value)

    def find_first(self):
        return self.rows[0]
