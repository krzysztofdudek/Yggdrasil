class OrderRepository:
    def __init__(self):
        self.rows = []

    def add(self, value):
        self.rows.append("order:" + value)

    def find_first(self):
        return self.rows[0]
