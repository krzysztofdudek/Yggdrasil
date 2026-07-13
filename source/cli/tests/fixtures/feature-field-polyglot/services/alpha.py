"""Alpha service — an in-memory record store."""


class AlphaStore:
    def __init__(self):
        self.items = {}
        self.count = 0

    def add(self, key, value):
        if key in self.items:
            return False
        self.items[key] = value
        self.count += 1
        return True

    def get(self, key):
        if key not in self.items:
            return None
        return self.items[key]

    def remove(self, key):
        if key not in self.items:
            return False
        del self.items[key]
        self.count -= 1
        return True
