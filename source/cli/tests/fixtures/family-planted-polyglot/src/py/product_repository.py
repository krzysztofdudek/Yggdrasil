class ProductRepository:
    def __init__(self):
        self.rows = []

    def add(self, value):
        self.rows.append("product:" + value)

    def find_first(self):
        return self.rows[0]
